# Plan d'implémentation — Wan 2.2 T2V + I2V

## Résumé

Remplacer Wan 2.1 par **Wan 2.2** (open-weights, Apache 2.0), ajouter l'I2V, passer les instances VIDEO à 24GB+ avec recherche du GPU le plus rapide.

## Fichiers modifiés

```
scripts/provision-wan21.sh    → scripts/provision-video.sh  (renommer + nouveau contenu)
src/lib/vast.ts               ← findCheapOffer, workflow Wan 2.2, I2V, timeout 30 min
src/routes/instances/routes.ts ← VRAM 24000, mode fastest
src/routes/instances/definitions.ts ← description à jour
src/routes/generate/routes.ts   ← Wan 2.2, frames variable, endpoint /video/img2vid
src/routes/generate/definitions.ts ← schéma I2V vidéo
prisma/schema.prisma           ← nouveau champ frames sur GenerationJob
```

---

## 1. Script de provision `scripts/provision-video.sh`

Remplacer `scripts/provision-wan21.sh` par `scripts/provision-video.sh`.

### Contenu

```bash
#!/bin/bash
set -eo pipefail

MODELS_DIR="/workspace/ComfyUI/models"

T2V_URL="https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_t2v_14B_fp8_scaled.safetensors"
I2V_HIGH_URL="https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_i2v_14B_fp8_high_scaled.safetensors"
I2V_LOW_URL="https://huggingface.co/Comfy-Org/Wan_2.2_ComfyUI_Repackaged/resolve/main/split_files/diffusion_models/wan2.2_i2v_14B_fp8_low_scaled.safetensors"
CLIP_VISION_URL="https://huggingface.co/Comfy-Org/Wan_2.1_ComfyUI_repackaged/resolve/main/split_files/clip_vision/clip_vision_h.safetensors"

# UMT5-XXL FP8 et Wan VAE sont déjà présents (communs avec Wan 2.1, déjà dans le template)

T2V_DEST="${MODELS_DIR}/diffusion_models/wan2.2_t2v_14B_fp8_scaled.safetensors"
I2V_HIGH_DEST="${MODELS_DIR}/diffusion_models/wan2.2_i2v_14B_fp8_high_scaled.safetensors"
I2V_LOW_DEST="${MODELS_DIR}/diffusion_models/wan2.2_i2v_14B_fp8_low_scaled.safetensors"
CLIP_VISION_DEST="${MODELS_DIR}/clip_vision/clip_vision_h.safetensors"

mkdir -p "${MODELS_DIR}/diffusion_models" "${MODELS_DIR}/clip_vision"

if [ ! -f "$T2V_DEST" ]; then
  echo "[provision] Downloading Wan 2.2 T2V 14B (~14GB)..."
  wget -q --show-progress -O "$T2V_DEST" "$T2V_URL"
fi

if [ ! -f "$I2V_HIGH_DEST" ]; then
  echo "[provision] Downloading Wan 2.2 I2V 14B high noise (~15GB)..."
  wget -q --show-progress -O "$I2V_HIGH_DEST" "$I2V_HIGH_URL"
fi

if [ ! -f "$I2V_LOW_DEST" ]; then
  echo "[provision] Downloading Wan 2.2 I2V 14B low noise (~15GB)..."
  wget -q --show-progress -O "$I2V_LOW_DEST" "$I2V_LOW_URL"
fi

if [ ! -f "$CLIP_VISION_DEST" ]; then
  echo "[provision] Downloading CLIP Vision H..."
  wget -q --show-progress -O "$CLIP_VISION_DEST" "$CLIP_VISION_URL"
fi

echo "[provision] Done — Wan 2.2 T2V + I2V ready"
```

### Mise à jour du lien dans `src/lib/vast.ts`

```typescript
const PROVISIONING_SCRIPTS: Record<string, string> = {
  IMAGE:
    'https://raw.githubusercontent.com/RomainMarcazzan/vast-sd-generator/main/scripts/provision-comfyui.sh',
  VIDEO:
    'https://raw.githubusercontent.com/RomainMarcazzan/vast-sd-generator/main/scripts/provision-video.sh',
};
```

---

## 2. `src/lib/vast.ts`

### 2a. `findCheapOffer` — ajouter param `mode`

```typescript
export async function findCheapOffer(
  minVramMb = 12000,
  mode: 'cheapest' | 'fastest' = 'cheapest',
): Promise<VastOffer> {
  const order =
    mode === 'fastest'
      ? [['dlperf', 'desc']]
      : [['dph_total', 'asc']];

  const res = await vastFetch('/api/v0/bundles/', {
    method: 'POST',
    body: JSON.stringify({
      gpu_ram: { gte: minVramMb },
      reliability: { gte: 0.95 },
      inet_down: { gte: 500 },
      disk_bw: { gte: 200 },
      dph_total: { gte: 0.15 },
      rentable: { eq: true },
      type: 'ondemand',
      limit: 5,
      order,
    }),
  });

  const data = (await res.json()) as { offers: VastOffer[] };
  if (!data.offers?.length) {
    throw new Error('No suitable GPU offers found on Vast.ai');
  }
  return data.offers[0];
}
```

### 2b. `buildTxt2VidWorkflow` — Wan 2.2, frames variable, fps supprimé

```typescript
function buildTxt2VidWorkflow(params: {
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  frames: number;
  steps: number;
  cfgScale: number;
  seed?: number;
}) {
  const seed = params.seed ?? Math.floor(Math.random() * 2 ** 32);
  return {
    prompt: {
      '1': {
        class_type: 'CLIPLoader',
        inputs: { clip_name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', type: 'wan' },
      },
      '2': {
        class_type: 'CLIPTextEncode',
        inputs: { text: params.prompt, clip: ['1', 0] },
      },
      '3': {
        class_type: 'CLIPTextEncode',
        inputs: { text: params.negativePrompt ?? '', clip: ['1', 0] },
      },
      '4': {
        class_type: 'VAELoader',
        inputs: { vae_name: 'wan_2.1_vae.safetensors' },
      },
      '5': {
        class_type: 'UNETLoader',
        inputs: {
          unet_name: 'wan2.2_t2v_14B_fp8_scaled.safetensors',
          weight_dtype: 'default',
        },
      },
      '6': {
        class_type: 'ModelSamplingSD3',
        inputs: { shift: 8, model: ['5', 0] },
      },
      '7': {
        class_type: 'EmptyHunyuanLatentVideo',
        inputs: {
          width: params.width,
          height: params.height,
          length: params.frames,
          batch_size: 1,
        },
      },
      '8': {
        class_type: 'KSampler',
        inputs: {
          seed,
          steps: params.steps,
          cfg: params.cfgScale,
          sampler_name: 'euler',
          scheduler: 'simple',
          denoise: 1,
          model: ['6', 0],
          positive: ['2', 0],
          negative: ['3', 0],
          latent_image: ['7', 0],
        },
      },
      '9': {
        class_type: 'VAEDecode',
        inputs: { samples: ['8', 0], vae: ['4', 0] },
      },
      '10': {
        class_type: 'VHS_VideoCombine',
        inputs: {
          images: ['9', 0],
          frame_rate: 16,
          loop_count: 0,
          filename_prefix: 'video/output',
          format: 'video/h264-mp4',
          save_output: true,
        },
      },
    },
  };
}
```

### 2c. `generateVideo` — timeout 20→30 min, fps supprimé des params

```typescript
export async function generateVideo(
  host: string,
  port: string,
  params: {
    prompt: string;
    negativePrompt?: string;
    width: number;
    height: number;
    frames: number;
    steps: number;
    cfgScale: number;
    seed?: number;
  },
): Promise<string> {
  const baseUrl = `http://${host}:${port}`;
  const workflow = buildTxt2VidWorkflow(params);

  const promptRes = await fetch(`${baseUrl}/prompt`, {
    method: 'POST',
    headers: comfyHeaders(),
    body: JSON.stringify(workflow),
  });
  if (!promptRes.ok) {
    throw new Error(`ComfyUI video submission failed: ${promptRes.status}`);
  }

  const { prompt_id } = (await promptRes.json()) as ComfyPromptResponse;

  const start = Date.now();
  const timeout = 30 * 60 * 1000;

  while (Date.now() - start < timeout) {
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const historyRes = await fetch(`${baseUrl}/history/${prompt_id}`, {
      headers: comfyHeaders(),
    });
    if (!historyRes.ok) continue;

    const history = (await historyRes.json()) as Record<string, ComfyHistoryEntry>;
    const entry = history[prompt_id];
    if (!entry) continue;

    for (const output of Object.values(entry.outputs)) {
      const gifs = (output as { gifs?: Array<{ filename: string; subfolder: string }> }).gifs;
      if (gifs?.length) {
        const { filename, subfolder } = gifs[0];
        return subfolder ? `${subfolder}/${filename}` : filename;
      }
    }
  }

  throw new Error('ComfyUI video generation timed out (30 min)');
}
```

### 2d. Nouveau `buildImg2VidWorkflow` — Wan 2.2 I2V (nodes natifs)

Workflow natif ComfyUI : LoadImage → CLIPLoader + CLIPTextEncode → CLIPVisionLoader + CLIPVisionEncode → ConditioningCombine → VAELoader + VAEEncode → UNETLoader (I2V) → ModelSamplingSD3 → KSampler → VAEDecode → VHS_VideoCombine.

```typescript
function buildImg2VidWorkflow(params: {
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  frames: number;
  steps: number;
  cfgScale: number;
  seed?: number;
  comfyImageFilename: string;
}) {
  const seed = params.seed ?? Math.floor(Math.random() * 2 ** 32);
  return {
    prompt: {
      '1': {
        class_type: 'CLIPLoader',
        inputs: { clip_name: 'umt5_xxl_fp8_e4m3fn_scaled.safetensors', type: 'wan' },
      },
      '2': {
        class_type: 'CLIPTextEncode',
        inputs: { text: params.prompt, clip: ['1', 0] },
      },
      '3': {
        class_type: 'CLIPTextEncode',
        inputs: { text: params.negativePrompt ?? '', clip: ['1', 0] },
      },
      '4': {
        class_type: 'LoadImage',
        inputs: { image: params.comfyImageFilename },
      },
      '5': {
        class_type: 'VAELoader',
        inputs: { vae_name: 'wan_2.1_vae.safetensors' },
      },
      '6': {
        class_type: 'VAEEncode',
        inputs: { pixels: ['4', 0], vae: ['5', 0] },
      },
      '7': {
        class_type: 'CLIPVisionLoader',
        inputs: { clip_name: 'clip_vision_h.safetensors' },
      },
      '8': {
        class_type: 'CLIPVisionEncode',
        inputs: { clip_vision: ['7', 0], image: ['4', 0] },
      },
      '9': {
        class_type: 'ConditioningCombine',
        inputs: { conditioning_1: ['2', 0], conditioning_2: ['8', 0] },
      },
      '10': {
        class_type: 'UNETLoader',
        inputs: {
          unet_name: 'wan2.2_i2v_14B_fp8_high_scaled.safetensors',
          weight_dtype: 'default',
        },
      },
      '11': {
        class_type: 'ModelSamplingSD3',
        inputs: { shift: 8, model: ['10', 0] },
      },
      '12': {
        class_type: 'EmptyHunyuanLatentVideo',
        inputs: {
          width: params.width,
          height: params.height,
          length: params.frames,
          batch_size: 1,
        },
      },
      '13': {
        class_type: 'KSampler',
        inputs: {
          seed,
          steps: params.steps,
          cfg: params.cfgScale,
          sampler_name: 'euler',
          scheduler: 'simple',
          denoise: 1,
          model: ['11', 0],
          positive: ['9', 0],
          negative: ['3', 0],
          latent_image: ['12', 0],
        },
      },
      '14': {
        class_type: 'VAEDecode',
        inputs: { samples: ['13', 0], vae: ['5', 0] },
      },
      '15': {
        class_type: 'VHS_VideoCombine',
        inputs: {
          images: ['14', 0],
          frame_rate: 16,
          loop_count: 0,
          filename_prefix: 'video/output',
          format: 'video/h264-mp4',
          save_output: true,
        },
      },
    },
  };
}
```

### 2e. Nouveau `generateVideoI2V`

```typescript
export async function generateVideoI2V(
  host: string,
  port: string,
  params: {
    prompt: string;
    negativePrompt?: string;
    width: number;
    height: number;
    frames: number;
    steps: number;
    cfgScale: number;
    seed?: number;
    comfyImageFilename: string;
  },
): Promise<string> {
  const baseUrl = `http://${host}:${port}`;
  const workflow = buildImg2VidWorkflow(params);

  const promptRes = await fetch(`${baseUrl}/prompt`, {
    method: 'POST',
    headers: comfyHeaders(),
    body: JSON.stringify(workflow),
  });
  if (!promptRes.ok) {
    throw new Error(`ComfyUI I2V submission failed: ${promptRes.status}`);
  }

  const { prompt_id } = (await promptRes.json()) as ComfyPromptResponse;

  const start = Date.now();
  const timeout = 30 * 60 * 1000;

  while (Date.now() - start < timeout) {
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const historyRes = await fetch(`${baseUrl}/history/${prompt_id}`, {
      headers: comfyHeaders(),
    });
    if (!historyRes.ok) continue;

    const history = (await historyRes.json()) as Record<string, ComfyHistoryEntry>;
    const entry = history[prompt_id];
    if (!entry) continue;

    for (const output of Object.values(entry.outputs)) {
      const gifs = (output as { gifs?: Array<{ filename: string; subfolder: string }> }).gifs;
      if (gifs?.length) {
        const { filename, subfolder } = gifs[0];
        return subfolder ? `${subfolder}/${filename}` : filename;
      }
    }
  }

  throw new Error('ComfyUI I2V generation timed out (30 min)');
}
```

---

## 3. `src/routes/instances/routes.ts`

Ligne de création d'instance (autour de la ligne 123-127) :

```typescript
const minVram = instanceType === 'VIDEO' ? 24000 : 12000;
const offer = await findCheapOffer(minVram, 'fastest');
```

---

## 4. `src/routes/instances/definitions.ts`

Mise à jour de la description du schema :

```typescript
export const createInstanceSchema = z.object({
  type: z
    .enum(['IMAGE', 'VIDEO'])
    .default('IMAGE')
    .describe('IMAGE (SDXL, 12GB VRAM) or VIDEO (Wan 2.2 T2V+I2V, 24GB VRAM)'),
  label: z.string().optional().describe('Optional label for the instance'),
});
```

---

## 5. Prisma — champ `frames` sur `GenerationJob`

### `prisma/schema.prisma`

```prisma
model GenerationJob {
  id             String         @id @default(cuid())
  prompt         String
  negativePrompt String?
  width          Int            @default(1024)
  height         Int            @default(1024)
  steps          Int            @default(20)
  cfgScale       Float          @default(7)
  sampler        String         @default("euler")
  scheduler      String         @default("normal")
  seed           BigInt?
  frames         Int?           // nombre de frames (81=5s, 161=10s, 241=15s)
  denoiseStrength Float?        // null = txt2img, set for img2img
  sourceImagePath String?       // source image path for img2img/img2vid
  mediaType      MediaType      @default(IMAGE)
  status         JobStatus      @default(PENDING)
  vastInstanceId String?
  errorMessage   String?
  image          GeneratedImage?
  video          GeneratedVideo?
  instanceId     String?
  instance       VastInstance?  @relation(fields: [instanceId], references: [id])
  createdAt      DateTime       @default(now())
  updatedAt      DateTime       @updatedAt
}
```

Puis : `npx prisma migrate dev --name add-frames`

---

## 6. `src/routes/generate/routes.ts`

### 6a. Handler `POST /video` — ajouter `frames` optionnel

```typescript
app.post('/video', async (c) => {
  let body: { prompt?: unknown; negativePrompt?: unknown; width?: unknown; height?: unknown; steps?: unknown; cfgScale?: unknown; sampler?: unknown; scheduler?: unknown; seed?: unknown; frames?: unknown; instanceId?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 422);
  }

  const prompt = body.prompt;
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return c.json({ error: 'prompt is required' }, 422);
  }

  const instanceId = body.instanceId;
  if (instanceId && typeof instanceId === 'string') {
    const instance = await prisma.vastInstance.findUnique({ where: { id: instanceId } });
    if (instance && instance.type !== 'VIDEO') {
      return c.json({ error: 'instanceId must reference a VIDEO instance' }, 422);
    }
  }

  const job = await prisma.generationJob.create({
    data: {
      prompt: prompt.trim(),
      negativePrompt: typeof body.negativePrompt === 'string' ? body.negativePrompt : null,
      width: Number(body.width ?? 832),
      height: Number(body.height ?? 480),
      steps: Number(body.steps ?? 20),
      cfgScale: Number(body.cfgScale ?? 6),
      sampler: typeof body.sampler === 'string' ? body.sampler : 'euler',
      scheduler: typeof body.scheduler === 'string' ? body.scheduler : 'simple',
      seed: body.seed != null ? Number(body.seed) : null,
      frames: Number(body.frames ?? 161),       // 10s par défaut
      mediaType: 'VIDEO',
    },
  });

  processVideoJob(job.id, typeof instanceId === 'string' ? instanceId : undefined);
  return c.json({ jobId: job.id }, 202);
});
```

### 6b. `processVideoJob` — utiliser `frames` du job

Dans `processVideoJob`, remplacer le hardcodage de frames par :

```typescript
const frames = job.frames ?? 161;
const outputFilename = await generateVideo(host, port, {
  prompt: job.prompt,
  negativePrompt: job.negativePrompt ?? undefined,
  width: job.width,
  height: job.height,
  frames,
  steps: job.steps,
  cfgScale: job.cfgScale,
  seed: job.seed !== null ? Number(job.seed) : undefined,
});
```

Mettre à jour l'enregistrement du `GeneratedVideo` : `frames: job.frames ?? 161` au lieu de `frames: 81`.

Mettre à jour le log : `Wan 2.1` → `Wan 2.2`.

Mettre à jour `findCheapOffer` : `findCheapOffer(24000, 'fastest')` au lieu de `findCheapOffer(16000)`.

Supprimer la ligne `fps: 16` du passage de params à `generateVideo`.

### 6c. Nouveau handler `POST /video/img2vid`

```typescript
app.post('/video/img2vid', async (c) => {
  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ error: 'Request must be multipart/form-data' }, 422);
  }

  const prompt = formData.get('prompt');
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return c.json({ error: 'prompt is required' }, 422);
  }

  const storagePath = env.IMAGES_STORAGE_PATH;
  let sourceImagePath: string;

  const imageFile = formData.get('image');
  const sourceJobId = formData.get('sourceJobId');

  if (imageFile && imageFile instanceof File) {
    if (!existsSync(storagePath)) mkdirSync(storagePath, { recursive: true });
    const uploadId = crypto.randomUUID();
    sourceImagePath = join(storagePath, `upload_${uploadId}.png`);
    writeFileSync(sourceImagePath, Buffer.from(await imageFile.arrayBuffer()));
  } else if (sourceJobId && typeof sourceJobId === 'string') {
    const sourceJob = await prisma.generationJob.findUnique({
      where: { id: sourceJobId },
      include: { image: true },
    });
    if (!sourceJob?.image) {
      return c.json({ error: 'Source job not found or has no image' }, 404);
    }
    sourceImagePath = sourceJob.image.path;
  } else {
    return c.json({ error: 'Provide either image (file) or sourceJobId' }, 422);
  }

  const frames = Number(formData.get('frames') ?? 161);
  const steps = Number(formData.get('steps') ?? 20);
  const cfgScale = Number(formData.get('cfgScale') ?? 6);
  const seedRaw = formData.get('seed');
  const seed = seedRaw ? Number(seedRaw) : null;
  const negativePrompt = formData.get('negativePrompt');

  const job = await prisma.generationJob.create({
    data: {
      prompt: prompt.trim(),
      negativePrompt: negativePrompt && typeof negativePrompt === 'string' ? negativePrompt : null,
      width: Number(formData.get('width') ?? 832),
      height: Number(formData.get('height') ?? 480),
      steps,
      cfgScale,
      sampler: 'euler',
      scheduler: 'simple',
      seed,
      frames,
      sourceImagePath,
      mediaType: 'VIDEO',
    },
  });

  processImg2VidJob(job.id, formData.get('instanceId')?.toString());
  return c.json({ jobId: job.id }, 202);
});
```

### 6d. Nouvelle fonction `processImg2VidJob`

```typescript
async function processImg2VidJob(jobId: string, persistentInstanceId?: string) {
  let vastInstanceId: number | null = null;
  let isPersistentInstance = false;
  const jobStart = Date.now();

  try {
    let host: string;
    let port: string;

    if (persistentInstanceId) {
      const instance = await prisma.vastInstance.findUnique({
        where: { id: persistentInstanceId },
      });
      if (!instance || instance.status !== 'RUNNING' || !instance.host || !instance.port) {
        throw new Error('Persistent instance not available');
      }
      host = instance.host;
      port = instance.port;
      vastInstanceId = Number(instance.vastInstanceId);
      isPersistentInstance = true;

      await prisma.vastInstance.update({
        where: { id: persistentInstanceId },
        data: { lastUsedAt: new Date() },
      });

      await prisma.generationJob.update({
        where: { id: jobId },
        data: {
          status: 'GENERATING',
          vastInstanceId: instance.vastInstanceId,
          instanceId: persistentInstanceId,
        },
      });
    } else {
      const offer = await findCheapOffer(24000, 'fastest');
      const instanceId = await createInstance(offer.id, 'VIDEO');
      vastInstanceId = instanceId;

      await prisma.generationJob.update({
        where: { id: jobId },
        data: { status: 'PROVISIONING', vastInstanceId: String(instanceId) },
      });

      const instance = await pollUntilReady(instanceId);
      const endpoint = getInstanceEndpoint(instance);
      host = endpoint.host;
      port = endpoint.port;

      await prisma.generationJob.update({ where: { id: jobId }, data: { status: 'GENERATING' } });
    }

    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } });
    if (!job.sourceImagePath) throw new Error('Missing source image');

    console.log(`[img2vid:${jobId}] Uploading source image to ComfyUI...`);
    const sourceBuffer = readFileSync(job.sourceImagePath);
    const comfyFilename = await uploadImageToComfy(host, port, sourceBuffer, `source_${jobId}.png`);

    const stepStart = Date.now();
    console.log(`[img2vid:${jobId}] Sending I2V prompt to ComfyUI (Wan 2.2)...`);
    const outputFilename = await generateVideoI2V(host, port, {
      prompt: job.prompt,
      negativePrompt: job.negativePrompt ?? undefined,
      width: job.width,
      height: job.height,
      frames: job.frames ?? 161,
      steps: job.steps,
      cfgScale: job.cfgScale,
      seed: job.seed !== null ? Number(job.seed) : undefined,
      comfyImageFilename,
    });

    const downloadStart = Date.now();
    const videoBuffer = await downloadVideo(host, port, outputFilename);

    const storagePath = env.IMAGES_STORAGE_PATH;
    if (!existsSync(storagePath)) mkdirSync(storagePath, { recursive: true });

    const filename = `${jobId}.mp4`;
    const filePath = join(storagePath, filename);
    writeFileSync(filePath, videoBuffer);
    const fileStats = statSync(filePath);

    await prisma.generatedVideo.create({
      data: {
        filename,
        path: filePath,
        sizeBytes: fileStats.size,
        width: job.width,
        height: job.height,
        fps: 16,
        frames: job.frames ?? 161,
        jobId,
      },
    });

    await prisma.generationJob.update({ where: { id: jobId }, data: { status: 'COMPLETED' } });
    console.log(`[img2vid:${jobId}] ✓ Completed [total: ${elapsed(jobStart)}]`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[img2vid:${jobId}] ✗ Failed after ${elapsed(jobStart)}: ${message}`);
    await prisma.generationJob
      .update({ where: { id: jobId }, data: { status: 'FAILED', errorMessage: message } })
      .catch(() => {});
  } finally {
    if (vastInstanceId && !isPersistentInstance) {
      await destroyInstance(vastInstanceId).catch(() => {});
    }
  }
}
```

---

## Notes importantes

### Workflow I2V

Le workflow I2V utilise uniquement des **nodes natifs ComfyUI** :
- `CLIPLoader` / `CLIPTextEncode` → encodage du prompt
- `LoadImage` / `VAEEncode` → encodage de l'image source en latent
- `CLIPVisionLoader` / `CLIPVisionEncode` → encodage visuel pour le conditioning
- `ConditioningCombine` → fusion du conditioning texte + image
- `UNETLoader` / `ModelSamplingSD3` → modèle I2V
- `EmptyHunyuanLatentVideo` → latent vidéo initial
- `KSampler` → sampling
- `VAEDecode` → décodage frames
- `VHS_VideoCombine` → export mp4

Pas de custom nodes Kijai nécessaires.

### Points à vérifier à l'implémentation

1. **ConditioningCombine** — vérifier que l'output de `CLIPVisionEncode` est compatible (type `conditioning`)
2. **EmptyHunyuanLatentVideo pour I2V** — vérifier que le latent vidéo vide fonctionne avec le modèle I2V (sinon remplacer par répétition du VAE latent)
3. **VRAM consommée** par l'I2V en 720p 10s sur RTX 4090 — ajuster les paramètres si nécessaire
4. **Shift du ModelSamplingSD3** pour Wan 2.2 (valeur exacte, pourrait différer de Wan 2.1)
5. **Test du workflow d'abord manuellement** en local ComfyUI avant de le coder dans l'API
6. **Ne pas oublier de `npx prisma generate`** après la migration

### Budget prévisionnel

| Ressource | Coût |
|-----------|:----:|
| Instance persistante VIDEO (RTX 4090) | ~$0.30/h |
| Wan 2.2 T2V 10s | ~$0.05/clip |
| Wan 2.2 I2V 10s | ~$0.03/clip |
| Provisionnement (téléchargement ~45GB) | ~$0.10 (la 1ère fois) |
