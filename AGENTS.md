# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Statut — Pipeline validé end-to-end (2026-06-18)

✅ Pipeline complet fonctionnel :
- `POST /api/v1/instances` → instance RUNNING en ~3 min
- `POST /api/v1/generate` avec `instanceId` → image générée via Qwen Image Max 2512
- `POST /api/v1/video` avec `instanceId` → vidéo générée via Wan 2.2 14B T2V (MoE)
- `POST /api/v1/video/img2vid` → vidéo générée via Wan 2.2 I2V avec image source
- Instance persistante : les générations suivantes sont plus rapides (modèle en VRAM)

**Contexte technique ComfyUI / Vast.ai :**
- ComfyUI écoute sur `127.0.0.1:18188`, Caddy proxie sur `*:8188` avec Basic Auth
- `WEB_ENABLE_AUTH=false` ignoré par le template — ne pas utiliser
- Fix : définir `WEB_USER`/`WEB_PASSWORD` à la création + passer Basic Auth dans toutes les requêtes ComfyUI
- Credentials dans `src/lib/vast.ts` : `COMFYUI_USER` / `COMFYUI_PASSWORD` (exportés, utilisés partout)
- `template_hash_id` obligatoire (`cc68218cbd560823cb841b721786077c`) — le nom Docker image seul ne fonctionne pas

## Overview

This is an **AI asset generation API** built on top of the Hono + Prisma + PostgreSQL stack.

The API server acts as an **orchestrator and file server** — heavy work (image/video inference) is offloaded to GPU instances rented on-demand via the **Vast.ai API**. Generated files are stored locally on disk under `IMAGES_STORAGE_PATH`.

```
POST /api/v1/generate              → { jobId }  txt2img (async, Qwen Image Max 2512)
POST /api/v1/generate/video        → { jobId }  txt2vid (async, Wan 2.2 14B T2V)
POST /api/v1/generate/video/img2vid → { jobId }  img2vid multipart (async, Wan 2.2 I2V)
GET  /api/v1/jobs/:id              → status polling (PENDING → PROVISIONING → GENERATING → COMPLETED)
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

- **Server** at `code-booking.fr` — API + PostgreSQL in Docker
- **Images/videos** stored on disk under `IMAGES_STORAGE_PATH`
- **Vast.ai** — GPU instances on demand ($0.15-0.90/h, always destroy after use)
- **Nginx** — reverse proxy with HTTPS

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
│   ├── vast.ts                 # Vast.ai + ComfyUI client (Qwen + Wan 2.2 workflows)
│   ├── prisma.ts
│   ├── error-handler.ts
├── schemas/generation.ts       # Zod + OpenAPI schemas
└── routes/
    ├── generate/               # POST /api/v1/generate (+ /video, /video/img2vid)
    ├── instances/              # POST/GET/DELETE /api/v1/instances
    ├── jobs/                   # GET /api/v1/jobs/:id
    ├── images/                 # GET/DELETE /api/v1/images
    └── videos/                 # GET/DELETE /api/v1/videos

scripts/
├── provision-comfyui.sh        # Qwen Image Max 2512 (diffusion model + text encoder + VAE)
└── provision-video.sh           # Wan 2.2 T2V+I2V (4 MoE diffusion models + VAE + text encoder)
```

### Prisma Models

```prisma
model GenerationJob {
  id              String         @id @default(cuid())
  prompt          String
  negativePrompt  String?
  width           Int            @default(1024)
  height          Int            @default(1024)
  steps           Int            @default(20)
  cfgScale        Float          @default(7)
  sampler         String         @default("euler")
  scheduler       String         @default("normal")
  seed            BigInt?        // null = random
  frames          Int            @default(81)  // video frames (VIDEO jobs)
  denoiseStrength Float?         // null = txt2img
  sourceImagePath String?        // source image for I2V
  mediaType       MediaType      @default(IMAGE)
  status          JobStatus      @default(PENDING)
  vastInstanceId  String?
  errorMessage    String?
  image           GeneratedImage?
  video           GeneratedVideo?
  instanceId      String?
  instance        VastInstance?  @relation(fields: [instanceId], references: [id])
  createdAt       DateTime       @default(now())
  updatedAt       DateTime       @updatedAt
}

model VastInstance {
  id              String          @id @default(cuid())
  vastInstanceId  String          @unique
  type            InstanceType    @default(IMAGE)
  status          InstanceStatus  @default(PROVISIONING)
  host            String?
  port            String?
  gpuName         String?
  costPerHour     Float?
  lastUsedAt      DateTime        @default(now())
  expiresAt       DateTime
  jobs            GenerationJob[]
  createdAt       DateTime        @default(now())
  updatedAt       DateTime        @updatedAt
}
```

### Vast.ai Client (`src/lib/vast.ts`)

- `findGpuOffer(minVram, mode, maxDph, minDiskGb)` — GPU avec `reliability >= 0.95`, `inet_down >= 500`, `disk_space >= minDiskGb*1024 MB`, `dph_total >= $0.15` et `<= $maxDph` ; mode `'cheapest'` ou `'fastest'`
- `createInstance(offerId, type)` — template ComfyUI (`cc68218cbd560823cb841b721786077c`), provisioning script IMAGE ou VIDEO, Basic Auth credentials
- `generateImage(host, port, params)` — workflow Qwen Image Max 2512 (UNETLoader → ModelSamplingAuraFlow → KSampler), poll `/history`
- `generateVideo(host, port, params)` — workflow Wan 2.2 T2V 14B (MoE: 2 UNETLoader + 2 KSamplerAdvanced + CreateVideo + SaveVideo), timeout 30 min
- `generateVideoI2V(host, port, params)` — workflow Wan 2.2 I2V 14B (WanImageToVideo + MoE), upload image d'abord
- `uploadImageToComfy(host, port, buffer, filename)` — `POST /upload/image` multipart
- `downloadImage(host, port, filename)` — télécharge l'image générée
- `downloadVideo(host, port, filename)` — télécharge la vidéo mp4 générée
- `COMFYUI_USER` / `COMFYUI_PASSWORD` — exportés, utilisés partout pour Basic Auth

Provisioning scripts :
- `IMAGE` → `scripts/provision-comfyui.sh` (Qwen Image 2512 fp8: diffusion model ~20GB, text encoder ~9GB, VAE)
- `VIDEO` → `scripts/provision-video.sh` (Wan 2.2: 4 MoE diffusion models ~56GB total + UMT5-XXL ~10GB + VAE ~1GB)

Instance types :
- `IMAGE` → 24GB VRAM min (`findGpuOffer(24000, 'fastest', 1.5)`), GPU assez puissant pour Qwen 2512
- `VIDEO` → 24GB VRAM min (`findGpuOffer(24000, 'fastest', 2)`), GPU assez puissant pour Wan 2.2 14B MoE

ComfyUI REST API (via Caddy port 8188) :
- `POST /upload/image` → upload source image pour I2V
- `POST /prompt` → `GET /history/{prompt_id}` → `GET /view?filename=...`

## Key Patterns

### Async Job Pattern
`POST /generate`, `POST /generate/video`, et `POST /generate/video/img2vid` créent un `GenerationJob` (PENDING) et retournent `{ jobId }` immédiatement. Un background async (fire-and-forget) avance le job à travers les états. En cas d'échec, status → FAILED + errorMessage, instance temporaire détruite.

**txt2vid** : accepte `instanceId` d'une instance VIDEO. Paramètres : width=832, height=480, steps=20, cfgScale=6, frames=81 (défauts). Génération via Wan 2.2 14B T2V MoE (2 diffusion models). Résultat dans `videoUrl` du job (mp4, 16fps).

**img2vid** : accepte `multipart/form-data` avec `image` (fichier) ou `sourceJobId` (job d'image existant). Utilise WanImageToVideo node + Wan 2.2 14B I2V MoE. Résultat dans `videoUrl`.

### Persistent Instances
```
POST /instances              → PROVISIONING (~3 min boot)
GET /instances               → poll jusqu'à RUNNING
POST /generate (instanceId)  → génération directe
DELETE /instances/:id        → destruction manuelle
```
Auto-destruction 30 min après création. ~10x moins cher pour 10+ générations.

### MoE Architecture (Wan 2.2)
Wan 2.2 utilise Mixture-of-Experts : chaque workflow charge **deux modèles** (high_noise + low_noise) qui opèrent sur des timesteps différents. Les modèles sont connectés via deux `KSamplerAdvanced` qui se partagent le débruitage :
- High noise : `start_at_step=0`, `end_at_step=steps/2`, `return_with_leftover_noise=enable`
- Low noise : `start_at_step=steps/2`, `end_at_step=steps`, `return_with_leftover_noise=disable`

Les `ModelSamplingSD3(shift=5)` s'appliquent indépendamment à chaque modèle du MoE.

### Error Handling
Centralisé dans `src/lib/error-handler.ts`. Pas de try/catch dans les route handlers. Prisma P2025→404, P2002→409.

### Route Pattern
Definitions dans `definitions.ts` (`createRoute()` + OpenAPI). Handlers dans `routes.ts` (`.openapi()`). Path params format OpenAPI `/{id}`. Dates en ISO string.

### Testing
Vitest + PostgreSQL réel (port 5433 via Docker). `app.request()` in-memory. Pas de mocks DB (sauf Vast.ai).

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



## Roadmap — Intégration video-platform

vast-sd-generator est le backend de génération d'assets pour un projet compagnon (`video-platform`) qui produit des documentaires YouTube complets.

### Stratégie d'assets (actuelle)

| Asset | Provider | Raison |
|-------|----------|--------|
| Images | Qwen Image Max 2512 sur Vast.ai | Self-hosted, qualité proche de FLUX, coût marginal (24GB VRAM) |
| Vidéos B-roll | Wan 2.2 sur Vast.ai | Self-hosted, MoE 14B, longueur illimitée |
| Vidéos hero shots | Kling via Replicate | Kling n'est pas open source — uniquement API |

### Prochaines étapes techniques

1. **Tester Wan 2.2 pour du B-roll documentaire**
   - Évaluer qualité vs Kling AI
   - Si acceptable → Wan 2.2 pour tous les clips
   - Wan 2.2 14B I2V supporté (WanImageToVideo node)

2. **Intégrer vast-sd-generator comme microservice dans video-platform**
   - video-platform appelle l'API REST au lieu de Replicate
   - Adapter au pattern async job (retourne `jobId`, poll jusqu'à COMPLETED)
   - Stratégie : instance persistante partagée pour toute une session de génération

3. **Ajouter le modèle TI2V 5B** (optionnel)
   - Modèle hybride T2V+I2V plus léger (8-12GB VRAM)
   - Utilise `wan2.2_vae.safetensors` (high compression)
   - Workflow avec `Wan22ImageToVideoLatent` node

## Code Style

Biome : single quotes, semicolons, 2-space indent, 100-char line width, trailing commas ES5.
