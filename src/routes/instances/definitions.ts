import { z } from '@hono/zod-openapi';

export const createInstanceSchema = z.object({
  type: z
    .enum(['IMAGE', 'VIDEO'])
    .default('IMAGE')
    .describe('IMAGE (SDXL, 12GB VRAM) or VIDEO (Wan 2.1, 16GB VRAM)'),
  label: z.string().optional().describe('Optional label for the instance'),
});

export const instanceResponseSchema = z.object({
  id: z.string(),
  vastInstanceId: z.string(),
  type: z.enum(['IMAGE', 'VIDEO']),
  status: z.enum(['PROVISIONING', 'RUNNING', 'DESTROYED']),
  host: z.string().nullable(),
  port: z.string().nullable(),
  gpuName: z.string().nullable(),
  costPerHour: z.number().nullable(),
  lastUsedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});

export const instanceListResponseSchema = z.array(instanceResponseSchema);
