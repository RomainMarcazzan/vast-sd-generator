import { env } from '../config/env.js';

const VAST_API_BASE = 'https://console.vast.ai';
const COMFYUI_TEMPLATE_HASH = 'cc68218cbd560823cb841b721786077c';
const COMFYUI_INTERNAL_PORT = '18188';
const PROVISIONING_SCRIPT_URL =
  'https://raw.githubusercontent.com/RomainMarcazzan/vast-sd-generator/main/scripts/provision-comfyui.sh';

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

export async function findCheapOffer(): Promise<VastOffer> {
  const res = await vastFetch('/api/v0/bundles/', {
    method: 'POST',
    body: JSON.stringify({
      gpu_ram: { gte: 12000 },
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

export async function createInstance(offerId: number): Promise<number> {
  const res = await vastFetch(`/api/v0/asks/${offerId}/`, {
    method: 'PUT',
    body: JSON.stringify({
      template_hash_id: COMFYUI_TEMPLATE_HASH,
      env: {
        '-p 18188:18188': '1',
        PROVISIONING_SCRIPT: PROVISIONING_SCRIPT_URL,
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

function buildTxt2ImgWorkflow(params: {
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  steps: number;
}) {
  return {
    prompt: {
      '3': {
        class_type: 'KSampler',
        inputs: {
          seed: Math.floor(Math.random() * 2 ** 32),
          steps: params.steps,
          cfg: 7,
          sampler_name: 'euler',
          scheduler: 'normal',
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

export async function generateImage(
  host: string,
  port: string,
  params: {
    prompt: string;
    negativePrompt?: string;
    width: number;
    height: number;
    steps: number;
  }
): Promise<string> {
  const baseUrl = `http://${host}:${port}`;
  const workflow = buildTxt2ImgWorkflow(params);

  // Submit prompt
  const promptRes = await fetch(`${baseUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

    const historyRes = await fetch(`${baseUrl}/history/${prompt_id}`);
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
  const res = await fetch(`http://${host}:${port}/view?filename=${encodeURIComponent(filename)}`);

  if (!res.ok) {
    throw new Error(`Failed to download image from ComfyUI: ${res.status}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

export async function destroyInstance(instanceId: number): Promise<void> {
  await vastFetch(`/api/v0/instances/${instanceId}/`, { method: 'DELETE' });
}
