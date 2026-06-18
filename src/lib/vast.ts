import { env } from '../config/env.js';

const VAST_API_BASE = 'https://console.vast.ai';
const COMFYUI_TEMPLATE_HASH = 'cc68218cbd560823cb841b721786077c';
const COMFYUI_INTERNAL_PORT = '8188';
export const COMFYUI_USER = 'vastai';
export const COMFYUI_PASSWORD = 'comfyui123';
const PROVISIONING_SCRIPTS: Record<string, string> = {
  IMAGE:
    'https://raw.githubusercontent.com/RomainMarcazzan/vast-sd-generator/main/scripts/provision-comfyui.sh',
  VIDEO:
    'https://raw.githubusercontent.com/RomainMarcazzan/vast-sd-generator/main/scripts/provision-video.sh',
};

// --- Types ---

interface VastOffer {
  id: number;
  gpu_name: string;
  num_gpus: number;
  gpu_ram: number;
  dph_total: number;
  reliability: number;
}

interface VastInstance {
  id: number;
  actual_status: string;
  public_ipaddr: string;
  ports: Record<string, Array<{ HostPort: string }>>;
}

interface ComfyPromptResponse {
  prompt_id: string;
}

interface ComfyHistoryOutput {
  images?: Array<{ filename: string; subfolder: string; type: string }>;
  videos?: Array<{ filename: string; subfolder: string; type: string }>;
  gifs?: Array<{ filename: string; subfolder: string; type: string }>;
}

interface ComfyHistoryEntry {
  outputs: Record<string, ComfyHistoryOutput>;
}

// --- Vast.ai API helpers ---

async function vastFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const res = await fetch(`${VAST_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${env.VAST_AI_API_KEY}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (res.status === 429) {
    throw new Error('Vast.ai rate limit exceeded — retry later');
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Vast.ai API error (${res.status}): ${body}`);
  }

  return res;
}

// --- Public API ---

export async function findGpuOffer(
  minVramMb = 12000,
  mode: 'cheapest' | 'fastest' = 'cheapest',
  maxDph = 2,
  minDiskGb = 50
): Promise<VastOffer> {
  const order = mode === 'fastest' ? [['dlperf', 'desc']] : [['dph_total', 'asc']];

  const res = await vastFetch('/api/v0/bundles/', {
    method: 'POST',
    body: JSON.stringify({
      gpu_ram: { gte: minVramMb },
      reliability: { gte: 0.95 },
      inet_down: { gte: 500 },
      disk_bw: { gte: 200 },
      disk_space: { gte: minDiskGb * 1024 },
      dph_total: { gte: 0.15, lte: maxDph },
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

export async function createInstance(
  offerId: number,
  type: 'IMAGE' | 'VIDEO' = 'IMAGE'
): Promise<number> {
  const res = await vastFetch(`/api/v0/asks/${offerId}/`, {
    method: 'PUT',
    body: JSON.stringify({
      template_hash_id: COMFYUI_TEMPLATE_HASH,
      env: {
        '-p 8188:8188': '1',
        PROVISIONING_SCRIPT: PROVISIONING_SCRIPTS[type],
        WEB_USER: COMFYUI_USER,
        WEB_PASSWORD: COMFYUI_PASSWORD,
      },
    }),
  });

  const data = (await res.json()) as { success: boolean; new_contract: number };

  if (!data.success || !data.new_contract) {
    throw new Error('Failed to create Vast.ai instance');
  }

  return data.new_contract;
}

export async function getInstance(instanceId: number): Promise<VastInstance | null> {
  const res = await vastFetch(`/api/v0/instances/${instanceId}/`);
  const data = (await res.json()) as { instances: VastInstance | null };
  return data.instances;
}

export async function pollUntilReady(
  instanceId: number,
  timeoutMs = 5 * 60 * 1000,
  intervalMs = 5000
): Promise<VastInstance> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const instance = await getInstance(instanceId);

    if (instance === null) {
      throw new Error('Instance no longer exists on Vast.ai');
    }

    if (instance.actual_status === 'running') {
      return instance;
    }

    if (instance.actual_status === 'exited' || instance.actual_status === 'error') {
      throw new Error(`Instance entered ${instance.actual_status} state`);
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Instance ${instanceId} did not become ready within ${timeoutMs / 1000}s`);
}

export function getInstanceEndpoint(instance: VastInstance): { host: string; port: string } {
  const portKey = `${COMFYUI_INTERNAL_PORT}/tcp`;
  const portMapping = instance.ports?.[portKey]?.[0];

  if (!portMapping || !instance.public_ipaddr) {
    throw new Error('Cannot resolve ComfyUI endpoint — missing port mapping or public IP');
  }

  return { host: instance.public_ipaddr, port: portMapping.HostPort };
}

// --- ComfyUI API ---

function comfyHeaders(): Record<string, string> {
  const credentials = Buffer.from(`${COMFYUI_USER}:${COMFYUI_PASSWORD}`).toString('base64');
  return {
    'Content-Type': 'application/json',
    Authorization: `Basic ${credentials}`,
  };
}

function comfyAuthHeader(): Record<string, string> {
  const credentials = Buffer.from(`${COMFYUI_USER}:${COMFYUI_PASSWORD}`).toString('base64');
  return { Authorization: `Basic ${credentials}` };
}

export async function uploadImageToComfy(
  host: string,
  port: string,
  imageBuffer: Buffer,
  filename: string
): Promise<string> {
  const formData = new FormData();
  const arrayBuffer = imageBuffer.buffer.slice(
    imageBuffer.byteOffset,
    imageBuffer.byteOffset + imageBuffer.byteLength
  ) as ArrayBuffer;
  formData.append('image', new Blob([arrayBuffer], { type: 'image/png' }), filename);
  formData.append('overwrite', 'true');

  const res = await fetch(`http://${host}:${port}/upload/image`, {
    method: 'POST',
    headers: comfyAuthHeader(),
    body: formData,
  });

  if (!res.ok) {
    throw new Error(`ComfyUI image upload failed: ${res.status}`);
  }

  const data = (await res.json()) as { name: string };
  return data.name;
}

function buildQwenTxt2ImgWorkflow(params: {
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  steps: number;
  cfgScale: number;
  sampler: string;
  scheduler: string;
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
          type: 'qwen_image',
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
        class_type: 'EmptySD3LatentImage',
        inputs: {
          width: params.width,
          height: params.height,
          batch_size: 1,
        },
      },
      '7': {
        class_type: 'ModelSamplingAuraFlow',
        inputs: { shift: 3.1, model: ['1', 0] },
      },
      '8': {
        class_type: 'KSampler',
        inputs: {
          seed,
          steps: params.steps,
          cfg: params.cfgScale,
          sampler_name: params.sampler,
          scheduler: params.scheduler,
          denoise: 1,
          model: ['7', 0],
          positive: ['3', 0],
          negative: ['4', 0],
          latent_image: ['6', 0],
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
    sampler: string;
    scheduler: string;
    seed?: number;
  }
): Promise<string> {
  const baseUrl = `http://${host}:${port}`;
  const workflow = buildQwenTxt2ImgWorkflow(params);

  // Submit prompt
  const promptRes = await fetch(`${baseUrl}/prompt`, {
    method: 'POST',
    headers: comfyHeaders(),
    body: JSON.stringify(workflow),
  });

  if (!promptRes.ok) {
    throw new Error(`ComfyUI prompt submission failed: ${promptRes.status}`);
  }

  const { prompt_id } = (await promptRes.json()) as ComfyPromptResponse;

  // Poll history until generation is complete
  const start = Date.now();
  const timeout = 5 * 60 * 1000;

  while (Date.now() - start < timeout) {
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const historyRes = await fetch(`${baseUrl}/history/${prompt_id}`, { headers: comfyHeaders() });
    if (!historyRes.ok) continue;

    const history = (await historyRes.json()) as Record<string, ComfyHistoryEntry>;
    const entry = history[prompt_id];

    if (!entry) continue;

    // Find the output image filename
    for (const output of Object.values(entry.outputs)) {
      if (output.images?.length) {
        return output.images[0].filename;
      }
    }
  }

  throw new Error('ComfyUI generation timed out');
}

export async function downloadImage(host: string, port: string, filename: string): Promise<Buffer> {
  const res = await fetch(`http://${host}:${port}/view?filename=${encodeURIComponent(filename)}`, {
    headers: comfyHeaders(),
  });

  if (!res.ok) {
    throw new Error(`Failed to download image from ComfyUI: ${res.status}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

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
  const split = Math.floor(params.steps / 2);
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
          unet_name: 'wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors',
          weight_dtype: 'default',
        },
      },
      '6': {
        class_type: 'ModelSamplingSD3',
        inputs: { shift: 5, model: ['5', 0] },
      },
      '7': {
        class_type: 'UNETLoader',
        inputs: {
          unet_name: 'wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors',
          weight_dtype: 'default',
        },
      },
      '8': {
        class_type: 'ModelSamplingSD3',
        inputs: { shift: 5, model: ['7', 0] },
      },
      '9': {
        class_type: 'EmptyHunyuanLatentVideo',
        inputs: {
          width: params.width,
          height: params.height,
          length: params.frames,
          batch_size: 1,
        },
      },
      '10': {
        class_type: 'KSamplerAdvanced',
        inputs: {
          noise_seed: seed,
          steps: params.steps,
          cfg: params.cfgScale,
          sampler_name: 'euler',
          scheduler: 'simple',
          start_at_step: 0,
          end_at_step: split,
          return_with_leftover_noise: 'enable',
          model: ['6', 0],
          positive: ['2', 0],
          negative: ['3', 0],
          latent_image: ['9', 0],
        },
      },
      '11': {
        class_type: 'KSamplerAdvanced',
        inputs: {
          noise_seed: seed,
          steps: params.steps,
          cfg: params.cfgScale,
          sampler_name: 'euler',
          scheduler: 'simple',
          start_at_step: split,
          end_at_step: params.steps,
          return_with_leftover_noise: 'disable',
          model: ['8', 0],
          positive: ['2', 0],
          negative: ['3', 0],
          latent_image: ['10', 0],
        },
      },
      '12': {
        class_type: 'VAEDecode',
        inputs: { samples: ['11', 0], vae: ['4', 0] },
      },
      '13': {
        class_type: 'CreateVideo',
        inputs: { images: ['12', 0], fps: 16 },
      },
      '14': {
        class_type: 'SaveVideo',
        inputs: { video: ['13', 0], filename_prefix: 'video/output' },
      },
    },
  };
}

function buildImg2VidWorkflow(params: {
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  frames: number;
  steps: number;
  cfgScale: number;
  seed?: number;
  imageFilename: string;
}) {
  const seed = params.seed ?? Math.floor(Math.random() * 2 ** 32);
  const split = Math.floor(params.steps / 2);
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
          unet_name: 'wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors',
          weight_dtype: 'default',
        },
      },
      '6': {
        class_type: 'ModelSamplingSD3',
        inputs: { shift: 5, model: ['5', 0] },
      },
      '7': {
        class_type: 'UNETLoader',
        inputs: {
          unet_name: 'wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors',
          weight_dtype: 'default',
        },
      },
      '8': {
        class_type: 'ModelSamplingSD3',
        inputs: { shift: 5, model: ['7', 0] },
      },
      '9': {
        class_type: 'LoadImage',
        inputs: { image: params.imageFilename },
      },
      '10': {
        class_type: 'WanImageToVideo',
        inputs: {
          positive: ['2', 0],
          negative: ['3', 0],
          vae: ['4', 0],
          start_image: ['9', 0],
          width: params.width,
          height: params.height,
          length: params.frames,
        },
      },
      '11': {
        class_type: 'KSamplerAdvanced',
        inputs: {
          noise_seed: seed,
          steps: params.steps,
          cfg: params.cfgScale,
          sampler_name: 'euler',
          scheduler: 'simple',
          start_at_step: 0,
          end_at_step: split,
          return_with_leftover_noise: 'enable',
          model: ['6', 0],
          positive: ['10', 0],
          negative: ['10', 1],
          latent_image: ['10', 2],
        },
      },
      '12': {
        class_type: 'KSamplerAdvanced',
        inputs: {
          noise_seed: seed,
          steps: params.steps,
          cfg: params.cfgScale,
          sampler_name: 'euler',
          scheduler: 'simple',
          start_at_step: split,
          end_at_step: params.steps,
          return_with_leftover_noise: 'disable',
          model: ['8', 0],
          positive: ['10', 0],
          negative: ['10', 1],
          latent_image: ['11', 0],
        },
      },
      '13': {
        class_type: 'VAEDecode',
        inputs: { samples: ['12', 0], vae: ['4', 0] },
      },
      '14': {
        class_type: 'CreateVideo',
        inputs: { images: ['13', 0], fps: 16 },
      },
      '15': {
        class_type: 'SaveVideo',
        inputs: { video: ['14', 0], filename_prefix: 'video/output' },
      },
    },
  };
}

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
  }
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
      for (const key of ['videos', 'gifs'] as const) {
        const items = output[key];
        if (items?.length) {
          const { filename, subfolder } = items[0];
          return subfolder ? `${subfolder}/${filename}` : filename;
        }
      }
    }
  }

  throw new Error('ComfyUI video generation timed out (30 min)');
}

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
    imageFilename: string;
  }
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
      for (const key of ['videos', 'gifs'] as const) {
        const items = output[key];
        if (items?.length) {
          const { filename, subfolder } = items[0];
          return subfolder ? `${subfolder}/${filename}` : filename;
        }
      }
    }
  }

  throw new Error('ComfyUI I2V generation timed out (30 min)');
}

export async function downloadVideo(host: string, port: string, filename: string): Promise<Buffer> {
  const res = await fetch(
    `http://${host}:${port}/view?filename=${encodeURIComponent(filename)}&type=output`,
    { headers: comfyAuthHeader() }
  );

  if (!res.ok) {
    throw new Error(`Failed to download video from ComfyUI: ${res.status}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

export async function destroyInstance(instanceId: number): Promise<void> {
  await vastFetch(`/api/v0/instances/${instanceId}/`, { method: 'DELETE' });
}
