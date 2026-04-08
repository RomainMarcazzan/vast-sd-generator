import { z } from '@hono/zod-openapi';

export const createInstanceSchema = z.object({
  label: z.string().optional().describe('Optional label for the instance'),
});

export const instanceResponseSchema = z.object({
  id: z.string(),
  vastInstanceId: z.string(),
  status: z.enum(['RUNNING', 'DESTROYED']),
  host: z.string().nullable(),
  port: z.string().nullable(),
  gpuName: z.string().nullable(),
  costPerHour: z.number().nullable(),
  lastUsedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});

export const instanceListResponseSchema = z.array(instanceResponseSchema);
