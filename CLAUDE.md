# CLAUDE.md

This file provides guidance to Claude Code when working with this repository.

## Overview

This is a **Stable Diffusion image generation API** built on top of the Hono + Prisma + PostgreSQL stack.

The RPi 3B+ (1GB RAM, USB drive ~45GB free) acts as an **orchestrator and file server** — it never does AI computation itself. Heavy work (Stable Diffusion inference) is offloaded to GPU instances rented on-demand via the **Vast.ai API**. Generated images are stored locally on the USB drive and served as static files.

### Core idea

```
[Client]
   │
   ▼
POST /api/v1/generate          ← submits a prompt, gets back a { jobId }
   │
   ▼
[Hono API on RPi]
   │  1. creates a GenerationJob in DB (status: pending)
   │  2. finds a cheap GPU offer on Vast.ai
   │  3. spins up an instance with ComfyUI
   │  4. polls until instance is ready
   │  5. sends the prompt to ComfyUI HTTP API
   │  6. downloads the image, saves to IMAGES_STORAGE_PATH
   │  7. updates GenerationJob (status: completed, imagePath)
   │
   ▼
GET /api/v1/jobs/:id           ← polling by the client to check status
GET /api/v1/images             ← list all generated images
GET /api/v1/images/:filename   ← serve image file (static)
DELETE /api/v1/images/:id      ← delete image + DB record
```

Generation is **asynchronous**: `POST /generate` returns immediately with a `jobId`. The client polls `GET /jobs/:id` until status is `completed` or `failed`.

## Infrastructure

- **RPi 3B+** at `rpi.code-booking.fr` — runs the Hono API + PostgreSQL in Docker
- **USB drive** mounted at `/` (57GB total, ~45GB free) — stores images under `IMAGES_STORAGE_PATH`
- **Vast.ai** — rents GPU instances on demand for SD inference
- **Nginx** on RPi — reverse proxy with HTTPS (Let's Encrypt)

## Common Commands

### Development
- `npm run dev` — Start development server with hot reload
- `npm run build` — Compile TypeScript to `dist/`
- `npm start` — Run compiled production build
- `npm run typecheck` — TypeScript check without emitting

### Testing
- `npm run test` — Run all tests once with Vitest
- `npm run test:watch` — Run tests in watch mode (auto-reload)

### Code Quality
- `npm run check` — Biome linter + formatter check
- `npm run check:fix` — Auto-fix formatting and linting
- `npm run precommit` — Biome check + TypeScript typecheck

### Database
- `npx prisma migrate dev` — Create and apply migration in development
- `npx prisma migrate deploy` — Apply pending migrations (production)
- `npx prisma generate` — Regenerate Prisma client to `src/generated/prisma/`
- `npx prisma studio` — Open database GUI

## Architecture

### Core Structure
```
src/
├── index.ts                    # Server startup (imports app.ts)
├── app.ts                      # Hono app configuration (routes, middleware) — testable
├── config/
│   └── env.ts                  # Env validation with Zod (includes VAST_AI_API_KEY, IMAGES_STORAGE_PATH)
├── lib/
│   ├── prisma.ts               # Prisma client singleton
│   ├── error-handler.ts        # Centralized error handling
│   ├── metrics.ts              # Prometheus metrics middleware
│   └── vast.ts                 # Vast.ai API client (find offer, create/destroy instance, poll status)
├── schemas/
│   └── generation.ts           # Zod + OpenAPI schemas for jobs and images
├── routes/
│   ├── generate/               # POST /api/v1/generate
│   │   ├── index.ts
│   │   ├── routes.ts
│   │   └── definitions.ts
│   ├── jobs/                   # GET /api/v1/jobs/:id
│   │   ├── index.ts
│   │   ├── routes.ts
│   │   └── definitions.ts
│   └── images/                 # GET /api/v1/images, GET /api/v1/images/:filename, DELETE
│       ├── index.ts
│       ├── routes.ts
│       └── definitions.ts
└── __tests__/                  # Vitest test suite
    ├── setup.ts                # Global mocks (Prisma, Vast.ai, fs)
    ├── generate.test.ts        # Tests for POST /api/v1/generate
    ├── jobs.test.ts            # Tests for GET /api/v1/jobs/:id
    └── images.test.ts          # Tests for /api/v1/images endpoints
```

### Prisma Models

```prisma
model GenerationJob {
  id             String    @id @default(cuid())
  prompt         String
  negativePrompt String?
  width          Int       @default(512)
  height         Int       @default(512)
  steps          Int       @default(20)
  status         JobStatus @default(PENDING)
  vastInstanceId String?   // Vast.ai instance ID (to destroy after use)
  errorMessage   String?
  image          GeneratedImage?
  createdAt      DateTime  @default(now())
  updatedAt      DateTime  @updatedAt
}

enum JobStatus {
  PENDING
  PROVISIONING   // waiting for Vast.ai instance to start
  GENERATING     // SD inference running
  COMPLETED
  FAILED
}

model GeneratedImage {
  id        String        @id @default(cuid())
  filename  String        @unique  // e.g. "abc123.png"
  path      String                 // absolute path on disk
  sizeBytes Int
  width     Int
  height    Int
  jobId     String        @unique
  job       GenerationJob @relation(fields: [jobId], references: [id])
  createdAt DateTime      @default(now())
}
```

### Vast.ai Client (`src/lib/vast.ts`)

Key operations:
- `findCheapOffer()` — queries Vast.ai for cheapest available GPU with `reliability >= 0.95`
- `createInstance(offerId)` — creates instance with ComfyUI Docker image (`vastai/comfy`), exposes port 18188
- `pollUntilReady(instanceId)` — polls every 5s until instance status is `running` (timeout: 5min)
- `getInstanceEndpoint(instance)` — extracts public IP and mapped port from instance data
- `generateImage(instanceHost, instancePort, params)` — calls ComfyUI HTTP API with the prompt
- `downloadImage(url)` — fetches image binary from the instance
- `destroyInstance(instanceId)` — destroys the instance after image is downloaded

All Vast.ai API calls use `Authorization: Bearer ${VAST_AI_API_KEY}`.

### ComfyUI Integration

The Vast.ai instance runs **ComfyUI** (Docker image: `vastai/comfy:latest`, official Vast.ai template).
A provisioning script auto-downloads SDXL (`sd_xl_base_1.0.safetensors`) on first boot.
ComfyUI exposes a REST API on internal port 18188 (mapped externally by Vast.ai):
- `POST /prompt` — submit a generation workflow
- `GET /history/{prompt_id}` — poll for completion and get output filenames
- `GET /view?filename=...` — download the generated image

The txt2img workflow JSON is templated in `src/lib/vast.ts`.

## Key Patterns

### Testing
Tests use Vitest with Hono's `app.request()` method (in-memory, no HTTP server needed).

**Setup:**
- `vitest.config.ts` configures the test environment with `setupFiles: ['./src/__tests__/setup.ts']`
- `setup.ts` provides global mocks for:
  - **Prisma** — all DB calls are mocked (no real PostgreSQL needed)
  - **Vast.ai** — API calls return fake data (no real GPU instances)
  - **fs** — file operations are mocked (no real disk writes)

**Writing tests:**
```typescript
import app from '../app.js';
import { prisma } from '../lib/prisma.js';

const mockPrisma = vi.mocked(prisma, true);

it('should create a job', async () => {
  mockPrisma.generationJob.create.mockResolvedValue({ id: 'test-id', ... });
  
  const res = await app.request('/api/v1/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'test' }),
  });
  
  expect(res.status).toBe(202);
});
```

### Error Handling
- Centralized in `src/lib/error-handler.ts` — do not add try/catch in route handlers
- `onErrorHandler`: handles HTTPException, Prisma errors (P2025→404, P2002→409), fallback 500
- `defaultHook`: Zod validation errors → 422 with details
- For explicit 404s: `return c.json({ error: '...' }, 404)`

### Async Job Pattern
- `POST /generate` creates a `GenerationJob` (status: `PENDING`) and returns `{ jobId }` immediately
- A background async function advances the job through states (no BullMQ — simple async/await fire-and-forget)
- If any step fails, job status is set to `FAILED` with `errorMessage`; Vast.ai instance is destroyed if it was created
- Client polls `GET /jobs/:id` — responds with current status + image URL when completed

### Image Storage
- Images saved to `${IMAGES_STORAGE_PATH}/${jobId}.png` (env var, default `/data/images`)
- Directory created on startup if it doesn't exist
- Served as static files via `GET /api/v1/images/:filename` using Hono's stream response
- `DELETE /api/v1/images/:id` removes both the DB record and the file on disk

### Route Pattern
- Definitions in `definitions.ts` with `createRoute()` + OpenAPI metadata
- Handlers in `routes.ts` with `.openapi()` method
- Path params use OpenAPI format `/{id}` (not Hono's `/:id`)
- Dates serialized to ISO strings

## Environment Variables

```
POSTGRES_USER=hono
POSTGRES_PASSWORD=hono123
POSTGRES_DB=hono_db
DATABASE_URL=postgresql://hono:hono123@localhost:5432/hono_db

PORT=3000
NODE_ENV=development
CORS_ORIGIN=*

SWAGGER_USER=admin
SWAGGER_PASSWORD=admin
SERVER_URL=http://localhost:3000

GRAFANA_USER=admin
GRAFANA_PASSWORD=admin

# Vast.ai API key — get it from https://cloud.vast.ai/account
VAST_AI_API_KEY=

# Where images are stored on disk (USB drive on RPi)
IMAGES_STORAGE_PATH=/data/images
```

## Docker & Deployment

Same pattern as the base template:
- Multi-stage Dockerfile (deps → build → production)
- **`docker-compose.yml`** — dev: PostgreSQL only (port 5432 exposed)
- **`docker-compose.prod.yml`** — prod: Hono API + PostgreSQL + VictoriaMetrics + Grafana
- Container names prefixed with `sd-generator-` to avoid collisions
- Images storage directory must be mounted as a Docker volume (prod):
  ```yaml
  volumes:
    - /data/images:/data/images
  ```
- Dev: `docker compose up -d` then `npm run dev`
- Prod: `docker compose -f docker-compose.prod.yml up -d --build`
- GitHub Actions CI/CD: push to `main` → SSH into RPi → `git pull` + `docker compose -f docker-compose.prod.yml up -d --build`
- RPi SSH: `ssh -p 2222 romain@rpi.code-booking.fr`

## API Documentation

- `/api/doc` — OpenAPI 3.1 JSON spec
- `/api/swagger` — Swagger UI (protected by Basic Auth in production)

## Code Style

Biome (`biome.json`): single quotes, semicolons, 2-space indent, 100-char line width, trailing commas (ES5), arrow functions always parenthesized.

## Notes

- Generated Prisma types committed to `src/generated/prisma/` for build consistency
- The app uses ES modules (`"type": "module"`) with `.js` extensions in imports
- Routes organized by resource: `src/routes/{resource}/{routes.ts,definitions.ts}`
- Schema sync: Prisma schema is source of truth; keep Zod schemas in sync, verify with `npm run typecheck`
- Vast.ai instances cost ~$0.10-0.30/h — always destroy after use to avoid unexpected charges
