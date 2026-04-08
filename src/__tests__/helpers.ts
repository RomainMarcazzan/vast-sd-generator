import type { JobStatus } from '../generated/prisma/client.js';
import { prisma } from '../lib/prisma.js';

export async function createJob(data: {
  prompt: string;
  negativePrompt?: string | null;
  width?: number;
  height?: number;
  steps?: number;
  status?: JobStatus;
  vastInstanceId?: string | null;
  errorMessage?: string | null;
}) {
  return prisma.generationJob.create({
    data: {
      prompt: data.prompt,
      negativePrompt: data.negativePrompt ?? null,
      width: data.width ?? 1024,
      height: data.height ?? 1024,
      steps: data.steps ?? 20,
      status: data.status ?? 'PENDING',
      vastInstanceId: data.vastInstanceId ?? null,
      errorMessage: data.errorMessage ?? null,
    },
  });
}

export async function createImage(data: {
  jobId: string;
  filename?: string;
  path?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
}) {
  return prisma.generatedImage.create({
    data: {
      jobId: data.jobId,
      filename: data.filename ?? `${data.jobId}.png`,
      path: data.path ?? `/tmp/test-images/${data.jobId}.png`,
      sizeBytes: data.sizeBytes ?? 1024,
      width: data.width ?? 1024,
      height: data.height ?? 1024,
    },
  });
}
