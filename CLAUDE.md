# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Statut — Pipeline validé end-to-end (2026-04-10)

✅ Pipeline complet fonctionnel :
- `POST /api/v1/instances` → instance RUNNING en ~3 min
- `POST /api/v1/generate` avec `instanceId` → image générée en ~13s (10s inference SDXL)
- Instance persistante : 2ème génération en 12.8s (modèle déjà en VRAM)

**Après un restart du serveur** : l'instance reste utilisable — elle est en DB avec status `RUNNING` + host/port. `POST /generate` avec le même `instanceId` fonctionne directement.

**Contexte technique ComfyUI / Vast.ai :**
- ComfyUI écoute sur `127.0.0.1:18188`, Caddy proxie sur `*:8188` avec Basic Auth
- `WEB_ENABLE_AUTH=false` ignoré par le template — ne pas utiliser
- Fix : définir `WEB_USER`/`WEB_PASSWORD` à la création + passer Basic Auth dans toutes les requêtes ComfyUI
- Credentials dans `src/lib/vast.ts` : `COMFYUI_USER` / `COMFYUI_PASSWORD` (exportés, utilisés dans `waitForComfyUI`, `generateImage`, `downloadImage`)
- `template_hash_id` obligatoire (`cc68218cbd560823cb841b721786077c`) — le nom Docker image seul ne fonctionne pas
- Modèles SDXL présents : `sd_xl_base_1.0.safetensors` + `sd_xl_turbo_1.0_fp16.safetensors`

## Overview

This is a **Stable Diffusion image generation API** built on top of the Hono + Prisma + PostgreSQL stack.

The RPi 3B+ acts as an **orchestrator and file server** — heavy work (SD inference) is offloaded to GPU instances rented on-demand via the **Vast.ai API**. Generated images are stored locally on the USB drive.

```
POST /api/v1/generate              → { jobId }  txt2img (async)
POST /api/v1/generate/img2img      → { jobId }  img2img multipart (async)
POST /api/v1/generate/video        → { jobId }  txt2vid (async, Wan 2.1 14B)
GET  /api/v1/jobs/:id              → status polling (PENDING → GENERATING → COMPLETED)
GET  /api/v1/images                → list images
GET  /api/v1/images/:filename      → serve image
DELETE /api/v1/images/:id
GET  /api/v1/videos                → list videos
GET  /api/v1/videos/:filename      → serve video (mp4)
DELETE /api/v1/videos/:id
POST /api/v1/instances             → create persistent GPU instance (IMAGE or VIDEO type)
GET  /api/v1/instances             → list instances
DELETE /api/v1/instances/:id       → destroy instance
```

## Infrastructure

- **RPi 3B+** at `rpi.code-booking.fr` — Hono API + PostgreSQL in Docker
- **USB drive** (~45GB free) — images stored under `IMAGES_STORAGE_PATH`
- **Vast.ai** — GPU instances on demand (~$0.05-0.30/h, always destroy after use)
- **Nginx** on RPi — reverse proxy with HTTPS

## Common Commands

```bash
npm run dev          # Dev server with hot reload
npm run build        # Compile TypeScript
npm run typecheck    # TS check only
npm run check:fix    # Biome auto-fix
npm run test         # Tests (Docker PostgreSQL)
npx prisma migrate dev   # Create + apply migration
npx prisma generate      # Regenerate Prisma client
npx prisma studio        # DB GUI
```

## Architecture

### Core Structure
```
src/
├── app.ts / index.ts
├── config/env.ts               # Zod env validation
├── lib/
│   ├── vast.ts                 # Vast.ai + ComfyUI client
│   ├── prisma.ts
│   ├── error-handler.ts
│   └── metrics.ts
├── schemas/generation.ts       # Zod + OpenAPI schemas
└── routes/
    ├── generate/               # POST /api/v1/generate (+ /img2img + /video)
    ├── instances/              # POST/GET/DELETE /api/v1/instances
    ├── jobs/                   # GET /api/v1/jobs/:id
    ├── images/                 # GET/DELETE /api/v1/images
    └── videos/                 # GET/DELETE /api/v1/videos

scripts/
├── provision-comfyui.sh        # SDXL models (IMAGE instances)
└── provision-wan21.sh          # Wan 2.1 14B + VideoHelperSuite (VIDEO instances)
```

### Prisma Models

```prisma
model GenerationJob {
  id             String          @id @default(cuid())
  prompt         String
  negativePrompt String?
  width          Int             @default(1024)
  height         Int             @default(1024)
  steps          Int             @default(20)
  cfgScale       Float           @default(7)
  sampler        String          @default("euler")
  scheduler      String          @default("normal")
  seed           BigInt?         // null = random
  status         JobStatus       @default(PENDING)
  vastInstanceId String?
  errorMessage   String?
  image          GeneratedImage?
  instanceId     String?
  instance       VastInstance?   @relation(fields: [instanceId], references: [id])
  createdAt      DateTime        @default(now())
  updatedAt      DateTime        @updatedAt
}

model VastInstance {
  id             String          @id @default(cuid())
  vastInstanceId String          @unique
  status         InstanceStatus  @default(PROVISIONING)
  host           String?
  port           String?
  gpuName        String?
  costPerHour    Float?
  lastUsedAt     DateTime        @default(now())
  expiresAt      DateTime
  jobs           GenerationJob[]
  createdAt      DateTime        @default(now())
  updatedAt      DateTime        @updatedAt
}
```

### Vast.ai Client (`src/lib/vast.ts`)

- `findCheapOffer(minVramMb)` — GPU avec `reliability >= 0.95`, `inet_down >= 500`, `dph_total >= $0.05`
- `createInstance(offerId, type)` — template ComfyUI (`cc68218cbd560823cb841b721786077c`), provisioning script IMAGE ou VIDEO, Basic Auth credentials
- `generateImage(host, port, params)` — workflow txt2img, poll `/history`
- `generateImg2Img(host, port, params)` — workflow img2img (LoadImage → VAEEncode → KSampler → VAEDecode)
- `uploadImageToComfy(host, port, buffer, filename)` — `POST /upload/image` multipart avant img2img
- `downloadImage(host, port, filename)` — télécharge l'image générée
- `generateVideo(host, port, params)` — workflow Wan 2.1 T2V 14B via VHS_VideoCombine, timeout 20 min, poll `gifs` key
- `downloadVideo(host, port, filename)` — télécharge la vidéo mp4 générée
- `COMFYUI_USER` / `COMFYUI_PASSWORD` — exportés, utilisés partout pour Basic Auth

Provisioning scripts :
- `IMAGE` → `scripts/provision-comfyui.sh` (modèles SDXL, déjà présents dans le template)
- `VIDEO` → `scripts/provision-wan21.sh` — télécharge Wan 2.1 14B fp8 (~26GB), UMT5-XXL (~10GB), VAE (~1GB) + installe ComfyUI-VideoHelperSuite

Instance types :
- `IMAGE` → 12GB VRAM min (`findCheapOffer(12000)`)
- `VIDEO` → 16GB VRAM min (`findCheapOffer(16000)`)

ComfyUI REST API (via Caddy port 8188) :
- `POST /upload/image` → upload source image pour img2img
- `POST /prompt` → `GET /history/{prompt_id}` → `GET /view?filename=...`

## Key Patterns

### Async Job Pattern
`POST /generate`, `POST /generate/img2img` et `POST /generate/video` créent un `GenerationJob` (PENDING) et retournent `{ jobId }` immédiatement. Un background async (fire-and-forget) avance le job à travers les états. En cas d'échec, status → FAILED + errorMessage, instance temporaire détruite.

**img2img** : accepte `multipart/form-data` avec `image` (fichier) ou `sourceJobId` (job existant) + `denoiseStrength` (0.0-1.0, défaut 0.75). Uploade l'image source à ComfyUI via `POST /upload/image` avant de soumettre le workflow.

**txt2vid** : accepte `instanceId` d'une instance VIDEO. Défauts : width=832, height=480, steps=20, cfgScale=6, scheduler=simple. Génération ~3-10 min selon le GPU. Résultat dans `videoUrl` du job (mp4, 81 frames, 16fps).

### Persistent Instances
```
POST /instances              → PROVISIONING (~3 min boot)
GET /instances               → poll jusqu'à RUNNING
POST /generate (instanceId)  → génération directe (~13s)
DELETE /instances/:id        → destruction manuelle
```
Auto-destruction 30 min après création. ~10x moins cher pour 10+ images.

### Error Handling
Centralisé dans `src/lib/error-handler.ts`. Pas de try/catch dans les route handlers. Prisma P2025→404, P2002→409.

### Route Pattern
Definitions dans `definitions.ts` (`createRoute()` + OpenAPI). Handlers dans `routes.ts` (`.openapi()`). Path params format OpenAPI `/{id}`. Dates en ISO string.

### Testing
Vitest + PostgreSQL réel (port 5433 via Docker). `app.request()` in-memory. Pas de mocks DB.

## Environment Variables

```
DATABASE_URL=postgresql://hono:hono123@localhost:5432/hono_db
PORT=3000
NODE_ENV=development
VAST_AI_API_KEY=
IMAGES_STORAGE_PATH=./data/images
SERVER_URL=http://localhost:3000
SWAGGER_USER=admin
SWAGGER_PASSWORD=admin
```

## Docker & Deployment

- `docker-compose.yml` — dev : PostgreSQL seul
- `docker-compose.prod.yml` — prod : API + PostgreSQL + VictoriaMetrics + Grafana
- Volume prod obligatoire : `/data/images:/data/images`
- CI/CD : push `main` → GitHub Actions → SSH RPi → `git pull` + `docker compose up --build`
- RPi SSH : `ssh -p 2222 romain@rpi.code-booking.fr`

## Roadmap — Intégration video-platform

vast-sd-generator est destiné à devenir le backend de génération d'assets pour un projet compagnon (`video-platform`) qui produit des documentaires YouTube complets (YouTube → transcription → script → assets → rendu Remotion).

Le problème actuel dans video-platform : Replicate (FLUX.1.1 Pro + Kling AI) est trop coûteux, ce qui oblige à limiter le nombre d'images et vidéos par documentaire, dégradant la qualité narrative.

### Stratégie d'assets (hybride)

| Asset | Provider cible | Raison |
|-------|---------------|--------|
| Images | FLUX.1 [dev] fp8 sur Vast.ai | Qualité proche de FLUX.1.1 Pro, coût marginal à l'heure |
| Vidéos B-roll | Wan 2.1 sur Vast.ai | Quantité illimitée, coût quasi nul |
| Vidéos hero shots | Kling via Replicate | Kling n'est pas open source — uniquement API |

**Note** : Kling AI (Kuaishou) n'est pas self-hostable. Si on veut des vidéos moins chères, Wan 2.1 est la seule option self-hosted. À tester sur des prompts documentaires avant de trancher.

### Prochaines étapes techniques

1. **Ajouter FLUX.1 [dev] fp8 à vast-sd-generator**
   - Modèle ~12GB, tourne sur 12-16GB VRAM (même instance IMAGE existante)
   - Nouveau workflow ComfyUI FLUX (différent du workflow SDXL)
   - Nouveau script de provisioning ou mise à jour de `provision-comfyui.sh`
   - Nouveau endpoint `POST /api/v1/generate/flux` ou paramètre `model: 'flux' | 'sdxl'`

2. **Tester Wan 2.1 pour du B-roll documentaire**
   - Évaluer la qualité vs Kling AI sur des prompts type documentaire
   - Si acceptable → Wan 2.1 pour tous les clips, économies majeures
   - Si non → Wan 2.1 pour B-roll générique, Kling pour les plans clés

3. **Intégrer vast-sd-generator comme microservice dans video-platform**
   - Pattern : video-platform appelle l'API REST de vast-sd-generator au lieu de Replicate
   - Adapter au pattern async job (retourne `jobId`, poll jusqu'à COMPLETED)
   - Gérer le warmup des instances (IMAGE ~3 min, VIDEO ~15-30 min + modèles)
   - Stratégie : instance persistante partagée pour toute une session de génération

## Code Style

Biome : single quotes, semicolons, 2-space indent, 100-char line width, trailing commas ES5.
