import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenAPIHono } from '@hono/zod-openapi';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import {
  createInstance,
  destroyInstance,
  downloadImage,
  findCheapOffer,
  generateImage,
  getInstanceEndpoint,
  pollUntilReady,
} from '../../lib/vast.js';
import { generateRoute } from './definitions.js';

const app = new OpenAPIHono();

async function processJob(jobId: string) {
  let vastInstanceId: number | null = null;

  try {
    // 1. PENDING → PROVISIONING: find offer and create instance
    const offer = await findCheapOffer();
    const instanceId = await createInstance(offer.id);
    vastInstanceId = instanceId;

    await prisma.generationJob.update({
      where: { id: jobId },
      data: { status: 'PROVISIONING', vastInstanceId: String(instanceId) },
    });

    // 2. PROVISIONING → GENERATING: wait for instance, send prompt
    const instance = await pollUntilReady(instanceId);
    const { host, port } = getInstanceEndpoint(instance);

    const job = await prisma.generationJob.update({
      where: { id: jobId },
      data: { status: 'GENERATING' },
    });

    // 3. GENERATING → COMPLETED: generate, download, save
    const outputFilename = await generateImage(host, port, {
      prompt: job.prompt,
      negativePrompt: job.negativePrompt ?? undefined,
      width: job.width,
      height: job.height,
      steps: job.steps,
    });

    const imageBuffer = await downloadImage(host, port, outputFilename);

    // Save image to disk
    const storagePath = env.IMAGES_STORAGE_PATH;
    if (!existsSync(storagePath)) {
      mkdirSync(storagePath, { recursive: true });
    }

    const filename = `${jobId}.png`;
    const filePath = join(storagePath, filename);
    writeFileSync(filePath, imageBuffer);

    const fileStats = statSync(filePath);

    // Create image record and update job
    await prisma.generatedImage.create({
      data: {
        filename,
        path: filePath,
        sizeBytes: fileStats.size,
        width: job.width,
        height: job.height,
        jobId,
      },
    });

    await prisma.generationJob.update({
      where: { id: jobId },
      data: { status: 'COMPLETED' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    await prisma.generationJob
      .update({
        where: { id: jobId },
        data: { status: 'FAILED', errorMessage: message },
      })
      .catch(() => {});
  } finally {
    // Always destroy the instance to stop billing
    if (vastInstanceId) {
      await destroyInstance(vastInstanceId).catch((err) => {
        console.error(`Failed to destroy instance ${vastInstanceId}:`, err);
      });
    }
  }
}

app.openapi(generateRoute, async (c) => {
  const body = c.req.valid('json');

  const job = await prisma.generationJob.create({
    data: {
      prompt: body.prompt,
      negativePrompt: body.negativePrompt,
      width: body.width,
      height: body.height,
      steps: body.steps,
    },
  });

  // Fire and forget — don't await
  processJob(job.id);

  return c.json({ jobId: job.id }, 202);
});

export default app;
