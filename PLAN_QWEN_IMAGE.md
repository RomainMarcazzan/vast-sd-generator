# Plan d'implémentation — Qwen Image Max 2512

## Résumé

Remplacer SDXL Base 1.0 (2023, Elo 874) par **Qwen Image Max 2512** (Alibaba, Elo 1,160), passer les instances IMAGE en mode `fastest`.

Même éditeur que Wan 2.2 (Alibaba Group) → harmonisation du projet.

## Simplification

En profondeur, on **retire tout ce qui était spécifique à SDXL** :
- Workflows `buildTxt2ImgWorkflow` / `buildImg2ImgWorkflow` SDXL → remplacés par Qwen
- `CheckpointLoaderSimple` disparaît (remplacé par `UNETLoader` + VAE séparé + text encoder séparé)
- Provision script `provision-comfyui.sh` réécrit (SDXL → Qwen Image + VAE + text encoder)
- Dépendance `sd_xl_base_1.0.safetensors` supprimée
- Paramètres `sampler`, `scheduler` peuvent être simplifiés (Qwen utilise ses propres réglages)

## Fichiers modifiés

```
scripts/provision-comfyui.sh    ← réécrit (SDXL → Qwen Image 2512)
src/lib/vast.ts                 ← workflows Qwen (txt2img + img2img)
src/routes/instances/routes.ts   ← mode fastest pour IMAGE
src/routes/instances/definitions.ts ← description à jour
src/routes/generate/routes.ts     ← defaults Qwen (steps, cfg)
```

(Pas de changement Prisma — les champs existants suffisent.)

---

## 1. Script de provision `scripts/provision-comfyui.sh`

Remplacer le téléchargement SDXL par les modèles Qwen Image 2512.

### Contenu

```bash
#!/bin/bash
set -eo pipefail

MODELS_DIR="/workspace/ComfyUI/models"

MODEL_URL="https://huggingface.co/Qwen/Qwen-Image-2512/resolve/main/qwen_image_2512_fp8_e4m3fn.safetensors"
VAE_URL="https://huggingface.co/Qwen/Qwen-Image-2512/resolve/main/qwen_image_vae.safetensors"
TE_URL="https://huggingface.co/Qwen/Qwen-Image-2512/resolve/main/qwen_2.5_vl_7b_fp8_scaled.safetensors"

MODEL_DEST="${MODELS_DIR}/diffusion_models/qwen_image_2512_fp8_e4m3fn.safetensors"
VAE_DEST="${MODELS_DIR}/vae/qwen_image_vae.safetensors"
TE_DEST="${MODELS_DIR}/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors"

mkdir -p "${MODELS_DIR}/diffusion_models" "${MODELS_DIR}/vae" "${MODELS_DIR}/text_encoders"

if [ ! -f "$MODEL_DEST" ]; then
  echo "[provision] Downloading Qwen Image 2512 fp8 (~12GB)..."
  wget -q --show-progress -O "$MODEL_DEST" "$MODEL_URL"
fi

if [ ! -f "$VAE_DEST" ]; then
  echo "[provision] Downloading Qwen VAE..."
  wget -q --show-progress -O "$VAE_DEST" "$VAE_URL"
fi

if [ ! -f "$TE_DEST" ]; then
  echo "[provision] Downloading Qwen text encoder 2.5 VL 7B fp8..."
  wget -q --show-progress -O "$TE_DEST" "$TE_URL"
fi

echo "[provision] Done — Qwen Image 2512 ready"
```

**Note** : le nom du repo HuggingFace exact (`Qwen/Qwen-Image-2512`) et les noms de fichiers sont à confirmer au moment de l'implémentation. Les chemins de dossiers (`diffusion_models/`, `vae/`, `text_encoders/`) sont ceux attendus par ComfyUI.

---

## 2. `src/lib/vast.ts`

### 2a. `buildQwenTxt2ImgWorkflow` — nouveau

Workflow natif ComfyUI pour Qwen Image 2512.
Structure probable (à vérifier avec le workflow officiel ComfyUI au moment de l'implémentation) :

```typescript
function buildQwenTxt2ImgWorkflow(params: {
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  steps: number;
  cfgScale: number;
  seed?: number;
}) {
  const seed = params.seed ?? Math.floor(Math.random() * 2 ** 32);
  return {
    prompt: {
      '1': {
        class_type: 'UNETLoader',
        inputs: {
          unet_name: 'qwen_image_2512_fp8_e4m3fn.safetensors',
          weight_dtype: 'default',
        },
      },
      '2': {
        class_type: 'CLIPLoader',
        inputs: {
          clip_name: 'qwen_2.5_vl_7b_fp8_scaled.safetensors',
          type: 'qwen2.5_vl',
        },
      },
      '3': {
        class_type: 'CLIPTextEncode',
        inputs: { text: params.prompt, clip: ['2', 0] },
      },
      '4': {
        class_type: 'CLIPTextEncode',
        inputs: { text: params.negativePrompt ?? '', clip: ['2', 0] },
      },
      '5': {
        class_type: 'VAELoader',
        inputs: { vae_name: 'qwen_image_vae.safetensors' },
      },
      '6': {
        class_type: 'EmptyLatentImage',
        inputs: {
          width: params.width,
          height: params.height,
          batch_size: 1,
        },
      },
      '7': {
        class_type: 'KSampler',
        inputs: {
          seed,
          steps: params.steps,
          cfg: params.cfgScale,
          sampler_name: 'euler',
          scheduler: 'normal',
          denoise: 1,
          model: ['1', 0],
          positive: ['3', 0],
          negative: ['4', 0],
          latent_image: ['6', 0],
        },
      },
      '8': {
        class_type: 'VAEDecode',
        inputs: { samples: ['7', 0], vae: ['5', 0] },
      },
      '9': {
        class_type: 'SaveImage',
        inputs: { filename_prefix: 'output', images: ['8', 0] },
      },
    },
  };
}
```

### 2b. `buildQwenImg2ImgWorkflow` — nouveau

```typescript
function buildQwenImg2ImgWorkflow(params: {
  prompt: string;
  negativePrompt?: string;
  steps: number;
  cfgScale: number;
  denoiseStrength: number;
  seed?: number;
  comfyImageFilename: string;
}) {
  const seed = params.seed ?? Math.floor(Math.random() * 2 ** 32);
  return {
    prompt: {
      '1': {
        class_type: 'UNETLoader',
        inputs: {
          unet_name: 'qwen_image_2512_fp8_e4m3fn.safetensors',
          weight_dtype: 'default',
        },
      },
      '2': {
        class_type: 'CLIPLoader',
        inputs: {
          clip_name: 'qwen_2.5_vl_7b_fp8_scaled.safetensors',
          type: 'qwen2.5_vl',
        },
      },
      '3': {
        class_type: 'CLIPTextEncode',
        inputs: { text: params.prompt, clip: ['2', 0] },
      },
      '4': {
        class_type: 'CLIPTextEncode',
        inputs: { text: params.negativePrompt ?? '', clip: ['2', 0] },
      },
      '5': {
        class_type: 'VAELoader',
        inputs: { vae_name: 'qwen_image_vae.safetensors' },
      },
      '6': {
        class_type: 'LoadImage',
        inputs: { image: params.comfyImageFilename },
      },
      '7': {
        class_type: 'VAEEncode',
        inputs: { pixels: ['6', 0], vae: ['5', 0] },
      },
      '8': {
        class_type: 'KSampler',
        inputs: {
          seed,
          steps: params.steps,
          cfg: params.cfgScale,
          sampler_name: 'euler',
          scheduler: 'normal',
          denoise: params.denoiseStrength,
          model: ['1', 0],
          positive: ['3', 0],
          negative: ['4', 0],
          latent_image: ['7', 0],
        },
      },
      '9': {
        class_type: 'VAEDecode',
        inputs: { samples: ['8', 0], vae: ['5', 0] },
      },
      '10': {
        class_type: 'SaveImage',
        inputs: { filename_prefix: 'output', images: ['9', 0] },
      },
    },
  };
}
```

### 2c. `generateImage` — utiliser Qwen au lieu de SDXL

```typescript
export async function generateImage(
  host: string,
  port: string,
  params: {
    prompt: string;
    negativePrompt?: string;
    width: number;
    height: number;
    steps: number;
    cfgScale: number;
    seed?: number;
  }
): Promise<string> {
  const baseUrl = `http://${host}:${port}`;
  const workflow = buildQwenTxt2ImgWorkflow(params);

  const promptRes = await fetch(`${baseUrl}/prompt`, {
    method: 'POST',
    headers: comfyHeaders(),
    body: JSON.stringify(workflow),
  });
  if (!promptRes.ok) {
    throw new Error(`ComfyUI prompt submission failed: ${promptRes.status}`);
  }

  const { prompt_id } = (await promptRes.json()) as ComfyPromptResponse;

  const start = Date.now();
  const timeout = 5 * 60 * 1000;

  while (Date.now() - start < timeout) {
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const historyRes = await fetch(`${baseUrl}/history/${prompt_id}`, { headers: comfyHeaders() });
    if (!historyRes.ok) continue;

    const history = (await historyRes.json()) as Record<string, ComfyHistoryEntry>;
    const entry = history[prompt_id];
    if (!entry) continue;

    for (const output of Object.values(entry.outputs)) {
      if (output.images?.length) {
        return output.images[0].filename;
      }
    }
  }

  throw new Error('ComfyUI generation timed out');
}
```

### 2d. `generateImg2Img` — utiliser Qwen

Même pattern : remplacer l'appel à `buildImg2ImgWorkflow` par `buildQwenImg2ImgWorkflow`.

### 2e. Supprimer l'ancien code SDXL

Retirer les fonctions obsolètes :
- `buildTxt2ImgWorkflow` (SDXL)
- `buildImg2ImgWorkflow` (SDXL)

---

## 3. `src/routes/instances/routes.ts`

Instance IMAGE passe en mode `fastest` (comme VIDEO) :

```typescript
const minVram = instanceType === 'VIDEO' ? 24000 : 12000;
const offer = await findCheapOffer(minVram, 'fastest');
```

---

## 4. `src/routes/instances/definitions.ts`

```typescript
export const createInstanceSchema = z.object({
  type: z
    .enum(['IMAGE', 'VIDEO'])
    .default('IMAGE')
    .describe('IMAGE (Qwen Image Max 2512, 12GB VRAM) or VIDEO (Wan 2.2 T2V+I2V, 24GB VRAM)'),
  label: z.string().optional().describe('Optional label for the instance'),
});
```

---

## 5. `src/routes/generate/routes.ts`

### 5a. Mettre à jour les defaults pour Qwen

Qwen Image 2512 a des réglages recommandés différents de SDXL :
- `steps`: 20–50 (contre 20 pour SDXL)
- `cfgScale`: 3–5 (contre 7 pour SDXL) — à vérifier
- `sampler`/`scheduler` : peuvent être simplifiés

```typescript
// Dans le handler POST / et POST /img2img
// Changer les defaults :
width: Number(body.width ?? 1024),
height: Number(body.height ?? 1024),
steps: Number(body.steps ?? 30),  // 20→30 (Qwen préfère plus de steps)
cfgScale: Number(body.cfgScale ?? 3.5),  // 7→3.5 (Qwen CFG différent de SDXL)
```

### 5b. Simplifier les paramètres exposés

Qwen Image n'utilise pas forcément `sampler` / `scheduler` de la même manière que SDXL. On peut soit :
- **Option A** : les garder pour compatibilité API (ils seront passés au KSampler inchangés)
- **Option B** : les retirer pour simplifier

Option A recommandée pour ne pas casser l'API.

---

## 6. Ancien code SDXL à supprimer

| Fichier | Code à retirer |
|---------|---------------|
| `scripts/provision-comfyui.sh` | Téléchargement `sd_xl_base_1.0.safetensors` |
| `src/lib/vast.ts` | `buildTxt2ImgWorkflow`, `buildImg2ImgWorkflow` |
| `src/lib/vast.ts` | Référence à `sd_xl_base_1.0.safetensors` dans les workflows |
| Template Vast.ai | Plus besoin de SDXL (mais le template ComfyUI reste le même) |

---

## Notes importantes

### Workflow

Le workflow Qwen Image 2512 repose sur des **nodes natifs ComfyUI** :
- `UNETLoader` → chargement du modèle de diffusion
- `CLIPLoader` (type `qwen2.5_vl`) → encodage du prompt
- `VAELoader` → chargement du VAE dédié
- `EmptyLatentImage` → latent initial
- `KSampler` → sampling
- `VAEDecode` → décodage

Pas de custom nodes nécessaires.

### Points à vérifier à l'implémentation

1. **Nom exact du repo HuggingFace** — `Qwen/Qwen-Image-2512` ou `Qwen/Qwen-Image-Max-2512` ?
2. **CLIPLoader type** — `qwen2.5_vl` est une supposition, vérifier le nom exact dans ComfyUI
3. **CFG scale optimal** — 3.5 est une estimation ; à tester
4. **Steps recommandés** — 30 est un bon compromis qualité/vitesse
5. **img2img** — vérifier que Qwen Image 2512 le supporte nativement (ou utiliser l'API Qwen-Image-Edit)
6. **Résolution max** — 2512 est supporté, mais 1024x1024 reste le plus stable
7. **Test du workflow d'abord manuellement** en local ComfyUI avant de le coder dans l'API
8. **Supprimer `provision-wan21.sh`** si on ne l'utilise plus (remplacé par `provision-video.sh` dans l'autre plan)

### Budget prévisionnel

| Ressource | Coût |
|-----------|:----:|
| Instance persistante IMAGE (RTX 4090) | ~$0.30/h |
| Qwen Image 2512 30 steps | ~$0.01/image |
| Provisionnement (téléchargement ~20GB) | ~$0.05 (1ère fois) |

### Alignement Alibaba

| Projet | Modèle | Éditeur | Licence |
|--------|--------|---------|---------|
| Images | Qwen Image Max 2512 | Alibaba (Qwen/Tongyi Lab) | Apache 2.0 |
| Vidéos | Wan 2.2 | Alibaba (Wan team) | Apache 2.0 |
