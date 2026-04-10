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
POST /api/v1/generate  → { jobId }   (async, returns immediately)
GET  /api/v1/jobs/:id  → status polling (PENDING → GENERATING → COMPLETED)
GET  /api/v1/images    → list images
GET  /api/v1/images/:filename → serve image
DELETE /api/v1/images/:id
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
    ├── generate/               # POST /api/v1/generate
    ├── instances/              # POST/GET/DELETE /api/v1/instances
    ├── jobs/                   # GET /api/v1/jobs/:id
    └── images/                 # GET/DELETE /api/v1/images
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

- `findCheapOffer()` — GPU avec `reliability >= 0.95`, `inet_down >= 500`, `dph_total >= $0.05`
- `createInstance(offerId)` — template ComfyUI (`cc68218cbd560823cb841b721786077c`), provisioning script SDXL, Basic Auth credentials
- `generateImage(host, port, params)` — soumet le workflow txt2img à ComfyUI, poll `/history`
- `downloadImage(host, port, filename)` — télécharge l'image générée
- `COMFYUI_USER` / `COMFYUI_PASSWORD` — exportés pour `waitForComfyUI` dans les routes instances

ComfyUI REST API (via Caddy port 8188) :
- `POST /prompt` → `GET /history/{prompt_id}` → `GET /view?filename=...`

## Key Patterns

### Async Job Pattern
`POST /generate` crée un `GenerationJob` (PENDING) et retourne `{ jobId }` immédiatement. Un background async (fire-and-forget) avance le job à travers les états. En cas d'échec, status → FAILED + errorMessage, instance temporaire détruite.

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

## Code Style

Biome : single quotes, semicolons, 2-space indent, 100-char line width, trailing commas ES5.
