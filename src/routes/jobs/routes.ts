import { OpenAPIHono } from '@hono/zod-openapi';
import { env } from '../../config/env.js';
import { defaultHook } from '../../lib/error-handler.js';
import { prisma } from '../../lib/prisma.js';
import { getJobRoute } from './definitions.js';

const app = new OpenAPIHono({ defaultHook });

app.openapi(getJobRoute, async (c) => {
  const { id } = c.req.valid('param');

  const job = await prisma.generationJob.findUnique({
    where: { id },
    include: { image: true },
  });

  if (!job) {
    return c.json({ error: 'Job not found' }, 404);
  }

  const imageUrl = job.image ? `${env.SERVER_URL}/api/v1/images/${job.image.filename}` : null;

  return c.json(
    {
      id: job.id,
      prompt: job.prompt,
      negativePrompt: job.negativePrompt,
      width: job.width,
      height: job.height,
      steps: job.steps,
      cfgScale: job.cfgScale,
      sampler: job.sampler,
      scheduler: job.scheduler,
      seed: job.seed !== null ? Number(job.seed) : null,
      status: job.status,
      errorMessage: job.errorMessage,
      imageUrl,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    },
    200
  );
});

export default app;
