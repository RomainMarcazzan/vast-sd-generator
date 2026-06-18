import { z } from '@hono/zod-openapi';

export const createInstanceSchema = z.object({
  type: z
    .enum(['IMAGE', 'VIDEO'])
    .default('IMAGE')
    .describe('IMAGE (Qwen Image Max 2512, 24GB VRAM) or VIDEO (Wan 2.2 T2V+I2V, 24GB VRAM)'),
  label: z.string().optional().describe('Optional label for the instance'),
  maxDph: z
    .number()
    .min(0.15)
    .max(10)
    .optional()
    .describe('Max $/hour for GPU selection (default: 1.5 for IMAGE, 2 for VIDEO)'),
  gpuMode: z
    .enum(['cheapest', 'fastest'])
    .optional()
    .describe("GPU selection mode: 'fastest' (best DLPerf within budget) or 'cheapest' (lowest price)"),
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
