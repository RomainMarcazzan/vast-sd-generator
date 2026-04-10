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
    'https://raw.githubusercontent.com/RomainMarcazzan/vast-sd-generator/main/scripts/provision-wan21.sh',
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

export async function findCheapOffer(minVramMb = 12000): Promise<VastOffer> {
  const res = await vastFetch('/api/v0/bundles/', {
    method: 'POST',
    body: JSON.stringify({
      gpu_ram: { gte: minVramMb },
      reliability: { gte: 0.95 },
      inet_down: { gte: 500 },
      disk_bw: { gte: 200 },
      dph_total: { gte: 0.05 },
      rentable: { eq: true },
      type: 'ondemand',
      limit: 5,
      order: [['dph_total', 'asc']],
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

function buildTxt2ImgWorkflow(params: {
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
  return {
    prompt: {
      '3': {
        class_type: 'KSampler',
        inputs: {
          seed: params.seed ?? Math.floor(Math.random() * 2 ** 32),
          steps: params.steps,
          cfg: params.cfgScale,
          sampler_name: params.sampler,
          scheduler: params.scheduler,
          denoise: 1,
          model: ['4', 0],
          positive: ['6', 0],
          negative: ['7', 0],
          latent_image: ['5', 0],
        },
      },
      '4': {
        class_type: 'CheckpointLoaderSimple',
        inputs: {
          ckpt_name: 'sd_xl_base_1.0.safetensors',
        },
      },
      '5': {
        class_type: 'EmptyLatentImage',
        inputs: {
          width: params.width,
          height: params.height,
          batch_size: 1,
        },
      },
      '6': {
        class_type: 'CLIPTextEncode',
        inputs: {
          text: params.prompt,
          clip: ['4', 1],
        },
      },
      '7': {
        class_type: 'CLIPTextEncode',
        inputs: {
          text: params.negativePrompt ?? '',
          clip: ['4', 1],
        },
      },
      '8': {
        class_type: 'VAEDecode',
        inputs: {
          samples: ['3', 0],
          vae: ['4', 2],
        },
      },
      '9': {
        class_type: 'SaveImage',
        inputs: {
          filename_prefix: 'output',
          images: ['8', 0],
        },
      },
    },
  };
}

function buildImg2ImgWorkflow(params: {
  prompt: string;
  negativePrompt?: string;
  steps: number;
  cfgScale: number;
  sampler: string;
  scheduler: string;
  denoiseStrength: number;
  seed?: number;
  comfyImageFilename: string;
}) {
  return {
    prompt: {
      '1': {
        class_type: 'LoadImage',
        inputs: { image: params.comfyImageFilename },
      },
      '2': {
        class_type: 'VAEEncode',
        inputs: { pixels: ['1', 0], vae: ['5', 2] },
      },
      '3': {
        class_type: 'KSampler',
        inputs: {
          seed: params.seed ?? Math.floor(Math.random() * 2 ** 32),
          steps: params.steps,
          cfg: params.cfgScale,
          sampler_name: params.sampler,
          scheduler: params.scheduler,
          denoise: params.denoiseStrength,
          model: ['5', 0],
          positive: ['6', 0],
          negative: ['7', 0],
          latent_image: ['2', 0],
        },
      },
      '4': {
        class_type: 'VAEDecode',
        inputs: { samples: ['3', 0], vae: ['5', 2] },
      },
      '5': {
        class_type: 'CheckpointLoaderSimple',
        inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' },
      },
      '6': {
        class_type: 'CLIPTextEncode',
        inputs: { text: params.prompt, clip: ['5', 1] },
      },
      '7': {
        class_type: 'CLIPTextEncode',
        inputs: { text: params.negativePrompt ?? '', clip: ['5', 1] },
      },
      '8': {
        class_type: 'SaveImage',
        inputs: { filename_prefix: 'output', images: ['4', 0] },
      },
    },
  };
}

export async function generateImg2Img(
  host: string,
  port: string,
  params: {
    prompt: string;
    negativePrompt?: string;
    steps: number;
    cfgScale: number;
    sampler: string;
    scheduler: string;
    denoiseStrength: number;
    seed?: number;
    comfyImageFilename: string;
  }
): Promise<string> {
  const baseUrl = `http://${host}:${port}`;
  const workflow = buildImg2ImgWorkflow(params);

  const promptRes = await fetch(`${baseUrl}/prompt`, {
    method: 'POST',
    headers: comfyHeaders(),
    body: JSON.stringify(workflow),
  });

  if (!promptRes.ok) {
    throw new Error(`ComfyUI img2img submission failed: ${promptRes.status}`);
  }

  const { prompt_id } = (await promptRes.json()) as ComfyPromptResponse;

  const start = Date.now();
  const timeout = 5 * 60 * 1000;

  while (Date.now() - start < timeout) {
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const historyRes = await fetch(`${baseUrl}/history/${prompt_id}`, {
      headers: comfyHeaders(),
    });
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

  throw new Error('ComfyUI img2img generation timed out');
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
  const workflow = buildTxt2ImgWorkflow(params);

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
  fps: number;
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
        inputs: { unet_name: 'wan2.1_t2v_14B_fp8_e4m3fn.safetensors', weight_dtype: 'default' },
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
          frame_rate: params.fps,
          loop_count: 0,
          filename_prefix: 'video/output',
          format: 'video/h264-mp4',
          save_output: true,
        },
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
    fps: number;
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
  const timeout = 20 * 60 * 1000; // 20 minutes for video

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
      // VHS_VideoCombine stores output under "gifs" key
      const gifs = (output as { gifs?: Array<{ filename: string; subfolder: string }> }).gifs;
      if (gifs?.length) {
        const { filename, subfolder } = gifs[0];
        return subfolder ? `${subfolder}/${filename}` : filename;
      }
    }
  }

  throw new Error('ComfyUI video generation timed out (20 min)');
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
