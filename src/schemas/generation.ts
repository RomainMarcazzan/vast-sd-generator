import { z } from 'zod';

// --- Request schemas ---

export const generateRequestSchema = z.object({
  prompt: z.string().min(1).max(2000),
  negativePrompt: z.string().max(2000).optional(),
  width: z.number().int().min(256).max(2512).default(1024),
  height: z.number().int().min(256).max(2512).default(1024),
  steps: z.number().int().min(1).max(100).default(30),
  cfgScale: z.number().min(1).max(20).default(3.5).describe('Classifier-free guidance scale'),
  sampler: z
    .string()
    .default('euler')
    .describe('Sampler name (e.g. euler, dpm++2m, euler_ancestral)'),
  scheduler: z.string().default('simple').describe('Scheduler (e.g. normal, karras, exponential)'),
  seed: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Fixed seed for reproducibility — omit for random'),
  instanceId: z.string().optional().describe('Optional persistent instance ID to reuse'),
  beatId: z
    .string()
    .max(50)
    .optional()
    .describe('Beat identifier from script (e.g. "1.1", "2.3") — used as output filename'),
});

// --- Response schemas ---

export const jobStatusSchema = z.enum([
  'PENDING',
  'PROVISIONING',
  'GENERATING',
  'COMPLETED',
  'FAILED',
]);

export const jobResponseSchema = z.object({
  id: z.string(),
  prompt: z.string(),
  negativePrompt: z.string().nullable(),
  width: z.number(),
  height: z.number(),
  steps: z.number(),
  cfgScale: z.number(),
  sampler: z.string(),
  scheduler: z.string(),
  seed: z.number().nullable(),
  denoiseStrength: z.number().nullable(),
  sourceImagePath: z.string().nullable(),
  mediaType: z.enum(['IMAGE', 'VIDEO']),
  status: jobStatusSchema,
  errorMessage: z.string().nullable(),
  imageUrl: z.string().nullable(),
  videoUrl: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const imageResponseSchema = z.object({
  id: z.string(),
  filename: z.string(),
  sizeBytes: z.number(),
  width: z.number(),
  height: z.number(),
  jobId: z.string(),
  createdAt: z.string().datetime(),
});

export const imageListResponseSchema = z.array(imageResponseSchema);
