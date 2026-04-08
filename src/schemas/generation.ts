import { z } from 'zod';

// --- Request schemas ---

export const generateRequestSchema = z.object({
  prompt: z.string().min(1).max(2000),
  negativePrompt: z.string().max(2000).optional(),
  width: z.number().int().min(256).max(2048).default(1024),
  height: z.number().int().min(256).max(2048).default(1024),
  steps: z.number().int().min(1).max(100).default(20),
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
  status: jobStatusSchema,
  errorMessage: z.string().nullable(),
  imageUrl: z.string().nullable(),
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
