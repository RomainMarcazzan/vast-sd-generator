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

function elapsed(start: number): string {
  const ms = Date.now() - start;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

async function processJob(jobId: string) {
  let vastInstanceId: number | null = null;
  const jobStart = Date.now();

  try {
    // 1. PENDING → PROVISIONING: find offer and create instance
    let stepStart = Date.now();
    console.log(`[job:${jobId}] Searching for GPU offer...`);
    const offer = await findCheapOffer();
    console.log(
      `[job:${jobId}] Found offer #${offer.id}: ${offer.gpu_name} (${offer.gpu_ram}MB) — $${offer.dph_total}/h [${elapsed(stepStart)}]`
    );

    stepStart = Date.now();
    console.log(`[job:${jobId}] Creating Vast.ai instance...`);
    const instanceId = await createInstance(offer.id);
    vastInstanceId = instanceId;
    console.log(`[job:${jobId}] Instance #${instanceId} created [${elapsed(stepStart)}]`);

    await prisma.generationJob.update({
      where: { id: jobId },
      data: { status: 'PROVISIONING', vastInstanceId: String(instanceId) },
    });

    // 2. PROVISIONING → GENERATING: wait for instance, send prompt
    stepStart = Date.now();
    console.log(`[job:${jobId}] Waiting for instance to be ready...`);
    const instance = await pollUntilReady(instanceId);
    const { host, port } = getInstanceEndpoint(instance);
    console.log(`[job:${jobId}] Instance ready at ${host}:${port} [${elapsed(stepStart)}]`);

    const job = await prisma.generationJob.update({
      where: { id: jobId },
      data: { status: 'GENERATING' },
    });

    // 3. GENERATING → COMPLETED: generate, download, save
    stepStart = Date.now();
    console.log(`[job:${jobId}] Sending prompt to ComfyUI...`);
    const outputFilename = await generateImage(host, port, {
      prompt: job.prompt,
      negativePrompt: job.negativePrompt ?? undefined,
      width: job.width,
      height: job.height,
      steps: job.steps,
    });
    console.log(`[job:${jobId}] Image generated: ${outputFilename} [${elapsed(stepStart)}]`);

    stepStart = Date.now();
    console.log(`[job:${jobId}] Downloading image...`);
    const imageBuffer = await downloadImage(host, port, outputFilename);
    console.log(
      `[job:${jobId}] Downloaded ${(imageBuffer.length / 1024).toFixed(0)}KB [${elapsed(stepStart)}]`
    );

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

    console.log(`[job:${jobId}] ✓ Completed [total: ${elapsed(jobStart)}]`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[job:${jobId}] ✗ Failed after ${elapsed(jobStart)}: ${message}`);
    await prisma.generationJob
      .update({
        where: { id: jobId },
        data: { status: 'FAILED', errorMessage: message },
      })
      .catch(() => {});
  } finally {
    // Always destroy the instance to stop billing
    if (vastInstanceId) {
      console.log(`[job:${jobId}] Destroying instance #${vastInstanceId}...`);
      await destroyInstance(vastInstanceId).catch((err) => {
        console.error(`[job:${jobId}] Failed to destroy instance ${vastInstanceId}:`, err);
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
