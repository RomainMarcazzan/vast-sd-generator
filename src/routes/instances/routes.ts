import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { defaultHook } from '../../lib/error-handler.js';
import { prisma } from '../../lib/prisma.js';
import {
  createInstance,
  destroyInstance,
  findCheapOffer,
  getInstance,
  getInstanceEndpoint,
} from '../../lib/vast.js';
import {
  createInstanceSchema,
  instanceListResponseSchema,
  instanceResponseSchema,
} from './definitions.js';

const app = new OpenAPIHono({ defaultHook });

// Timeout auto : 30 minutes
const INSTANCE_TIMEOUT_MINUTES = 30;

const listInstancesRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Instances'],
  summary: 'List all active Vast.ai instances',
  responses: {
    200: {
      description: 'List of instances',
      content: {
        'application/json': {
          schema: instanceListResponseSchema,
        },
      },
    },
  },
});

const createInstanceRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Instances'],
  summary: 'Create a new persistent Vast.ai instance',
  request: {
    body: {
      content: {
        'application/json': {
          schema: createInstanceSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Instance created',
      content: {
        'application/json': {
          schema: instanceResponseSchema,
        },
      },
    },
    422: {
      description: 'Validation error',
    },
  },
});

const deleteInstanceRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Instances'],
  summary: 'Destroy a Vast.ai instance',
  request: {
    params: z.object({
      id: z.string(),
    }),
  },
  responses: {
    200: {
      description: 'Instance destroyed',
      content: {
        'application/json': {
          schema: z.object({ message: z.string() }),
        },
      },
    },
    404: {
      description: 'Instance not found',
    },
  },
});

// List active instances
app.openapi(listInstancesRoute, async (c) => {
  const instances = await prisma.vastInstance.findMany({
    where: { status: { in: ['PROVISIONING', 'RUNNING'] } },
    orderBy: { lastUsedAt: 'desc' },
  });

  return c.json(
    instances.map((inst) => ({
      id: inst.id,
      vastInstanceId: inst.vastInstanceId,
      status: inst.status,
      host: inst.host,
      port: inst.port,
      gpuName: inst.gpuName,
      costPerHour: inst.costPerHour,
      lastUsedAt: inst.lastUsedAt.toISOString(),
      expiresAt: inst.expiresAt.toISOString(),
      createdAt: inst.createdAt.toISOString(),
    })),
    200
  );
});

// Create instance
app.openapi(createInstanceRoute, async (c) => {
  console.log('[instance] Searching for GPU offer...');
  const offer = await findCheapOffer();
  console.log(`[instance] Found offer #${offer.id}: ${offer.gpu_name}`);

  console.log('[instance] Creating Vast.ai instance...');
  const vastId = await createInstance(offer.id);
  console.log(`[instance] Instance #${vastId} created`);

  // Sauver en DB immédiatement avec status PROVISIONING
  const expiresAt = new Date();
  expiresAt.setMinutes(expiresAt.getMinutes() + INSTANCE_TIMEOUT_MINUTES);

  const dbInstance = await prisma.vastInstance.create({
    data: {
      vastInstanceId: String(vastId),
      gpuName: offer.gpu_name,
      costPerHour: offer.dph_total,
      expiresAt,
    },
  });

  // Poll en background (fire-and-forget)
  provisionInstance(dbInstance.id, vastId);

  return c.json(
    {
      id: dbInstance.id,
      vastInstanceId: dbInstance.vastInstanceId,
      status: dbInstance.status,
      host: dbInstance.host,
      port: dbInstance.port,
      gpuName: dbInstance.gpuName,
      costPerHour: dbInstance.costPerHour,
      lastUsedAt: dbInstance.lastUsedAt.toISOString(),
      expiresAt: dbInstance.expiresAt.toISOString(),
      createdAt: dbInstance.createdAt.toISOString(),
    },
    201
  );
});

// Delete instance
app.openapi(deleteInstanceRoute, async (c) => {
  const { id } = c.req.valid('param');

  const instance = await prisma.vastInstance.findUnique({
    where: { id },
  });

  if (!instance || (instance.status !== 'RUNNING' && instance.status !== 'PROVISIONING')) {
    return c.json({ error: 'Instance not found' }, 404);
  }

  console.log(`[instance] Destroying instance #${instance.vastInstanceId}...`);
  await destroyInstance(Number(instance.vastInstanceId)).catch((err) => {
    console.error(`[instance] Failed to destroy:`, err);
  });

  await prisma.vastInstance.update({
    where: { id },
    data: { status: 'DESTROYED' },
  });

  return c.json({ message: 'Instance destroyed' }, 200);
});

// Attend que ComfyUI soit prêt à recevoir des requêtes
async function waitForComfyUI(host: string, port: string, vastId: number) {
  const url = `http://${host}:${port}/system_stats`;
  const INTERVAL_MS = 10_000;

  while (true) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      console.log(`[instance] ComfyUI #${vastId} /system_stats → HTTP ${res.status}`);
      if (res.ok) {
        console.log(`[instance] ComfyUI #${vastId} is ready`);
        return;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`[instance] ComfyUI #${vastId} /system_stats → ${msg}`);
    }
    console.log(
      `[instance] ComfyUI #${vastId} not ready yet, retrying in ${INTERVAL_MS / 1000}s...`
    );
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
}

// Poll en background jusqu'à ce que l'instance soit ready
async function provisionInstance(dbInstanceId: string, vastId: number) {
  const POLL_INTERVAL_MS = 30_000;

  try {
    while (true) {
      const instance = await getInstance(vastId);

      if (instance === null) {
        throw new Error('Instance no longer exists on Vast.ai (deleted externally?)');
      }

      if (instance.actual_status === 'running') {
        const { host, port } = getInstanceEndpoint(instance);
        console.log(
          `[instance] Instance #${vastId} container running at ${host}:${port}, waiting for ComfyUI...`
        );

        await waitForComfyUI(host, port, vastId);

        await prisma.vastInstance.update({
          where: { id: dbInstanceId },
          data: { status: 'RUNNING', host, port },
        });

        console.log(`[instance] Instance #${vastId} ready`);
        scheduleAutoDestroy(dbInstanceId, vastId, INSTANCE_TIMEOUT_MINUTES);
        return;
      }

      if (instance.actual_status === 'exited' || instance.actual_status === 'error') {
        throw new Error(`Instance entered ${instance.actual_status} state`);
      }

      console.log(`[instance] Instance #${vastId} status: ${instance.actual_status}`);
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[instance] Provisioning failed for #${vastId}: ${message}`);

    await destroyInstance(vastId).catch((err) => {
      console.error(`[instance] Failed to destroy #${vastId}:`, err);
    });

    await prisma.vastInstance.update({
      where: { id: dbInstanceId },
      data: { status: 'DESTROYED' },
    });
  }
}

// Fonction pour programmer la destruction auto
function scheduleAutoDestroy(instanceId: string, vastId: number, minutes: number) {
  setTimeout(
    async () => {
      console.log(`[instance] Auto-destroying instance #${vastId} after ${minutes}min timeout...`);
      try {
        await destroyInstance(vastId);
        await prisma.vastInstance.update({
          where: { id: instanceId },
          data: { status: 'DESTROYED' },
        });
        console.log(`[instance] Instance #${vastId} auto-destroyed`);
      } catch (err) {
        console.error(`[instance] Failed to auto-destroy instance #${vastId}:`, err);
      }
    },
    minutes * 60 * 1000
  );
}

export default app;
