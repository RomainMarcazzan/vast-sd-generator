import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { defaultHook } from '../../lib/error-handler.js';
import { prisma } from '../../lib/prisma.js';
import {
  createInstance,
  destroyInstance,
  findCheapOffer,
  getInstanceEndpoint,
  pollUntilReady,
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
    where: { status: 'RUNNING' },
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

  console.log('[instance] Waiting for instance to be ready...');
  const instance = await pollUntilReady(vastId);
  const { host, port } = getInstanceEndpoint(instance);
  console.log(`[instance] Instance ready at ${host}:${port}`);

  // Calculer la date d'expiration
  const expiresAt = new Date();
  expiresAt.setMinutes(expiresAt.getMinutes() + INSTANCE_TIMEOUT_MINUTES);

  const dbInstance = await prisma.vastInstance.create({
    data: {
      vastInstanceId: String(vastId),
      host,
      port,
      gpuName: offer.gpu_name,
      costPerHour: offer.dph_total,
      expiresAt,
    },
  });

  // Programmer la destruction automatique
  scheduleAutoDestroy(dbInstance.id, vastId, INSTANCE_TIMEOUT_MINUTES);

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

  if (!instance || instance.status === 'DESTROYED') {
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
