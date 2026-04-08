import { OpenAPIHono } from '@hono/zod-openapi';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { getJobRoute } from './definitions.js';

const app = new OpenAPIHono();

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
