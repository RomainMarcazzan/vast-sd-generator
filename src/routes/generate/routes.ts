import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpenAPIHono } from '@hono/zod-openapi';
import { env } from '../../config/env.js';
import { defaultHook } from '../../lib/error-handler.js';
import { prisma } from '../../lib/prisma.js';
import {
  createInstance,
  destroyInstance,
  downloadImage,
  findCheapOffer,
  generateImage,
  generateImg2Img,
  getInstanceEndpoint,
  pollUntilReady,
  uploadImageToComfy,
} from '../../lib/vast.js';
import { generateRoute } from './definitions.js';

const app = new OpenAPIHono({ defaultHook });

function elapsed(start: number): string {
  const ms = Date.now() - start;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

async function processJob(jobId: string, persistentInstanceId?: string) {
  let vastInstanceId: number | null = null;
  let isPersistentInstance = false;
  const jobStart = Date.now();

  try {
    let host: string;
    let port: string;

    if (persistentInstanceId) {
      // Mode instance persistante
      console.log(`[job:${jobId}] Using persistent instance ${persistentInstanceId}...`);
      const instance = await prisma.vastInstance.findUnique({
        where: { id: persistentInstanceId },
      });

      if (!instance || instance.status !== 'RUNNING' || !instance.host || !instance.port) {
        throw new Error('Persistent instance not available');
      }

      host = instance.host;
      port = instance.port;
      vastInstanceId = Number(instance.vastInstanceId);
      isPersistentInstance = true;

      // Mettre à jour lastUsedAt
      await prisma.vastInstance.update({
        where: { id: persistentInstanceId },
        data: { lastUsedAt: new Date() },
      });

      await prisma.generationJob.update({
        where: { id: jobId },
        data: {
          status: 'GENERATING',
          vastInstanceId: instance.vastInstanceId,
          instanceId: persistentInstanceId,
        },
      });
    } else {
      // Mode auto : créer une instance temporaire
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

      stepStart = Date.now();
      console.log(`[job:${jobId}] Waiting for instance to be ready...`);
      const instance = await pollUntilReady(instanceId);
      const endpoint = getInstanceEndpoint(instance);
      host = endpoint.host;
      port = endpoint.port;
      console.log(`[job:${jobId}] Instance ready at ${host}:${port} [${elapsed(stepStart)}]`);

      await prisma.generationJob.update({
        where: { id: jobId },
        data: { status: 'GENERATING' },
      });
    }

    // Génération de l'image
    const stepStart = Date.now();
    console.log(`[job:${jobId}] Sending prompt to ComfyUI...`);
    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } });
    const outputFilename = await generateImage(host, port, {
      prompt: job.prompt,
      negativePrompt: job.negativePrompt ?? undefined,
      width: job.width,
      height: job.height,
      steps: job.steps,
      cfgScale: job.cfgScale,
      sampler: job.sampler,
      scheduler: job.scheduler,
      seed: job.seed !== null ? Number(job.seed) : undefined,
    });
    console.log(`[job:${jobId}] Image generated: ${outputFilename} [${elapsed(stepStart)}]`);

    // Download
    const downloadStart = Date.now();
    console.log(`[job:${jobId}] Downloading image...`);
    const imageBuffer = await downloadImage(host, port, outputFilename);
    console.log(
      `[job:${jobId}] Downloaded ${(imageBuffer.length / 1024).toFixed(0)}KB [${elapsed(downloadStart)}]`
    );

    // Save
    const storagePath = env.IMAGES_STORAGE_PATH;
    if (!existsSync(storagePath)) {
      mkdirSync(storagePath, { recursive: true });
    }

    const filename = `${jobId}.png`;
    const filePath = join(storagePath, filename);
    writeFileSync(filePath, imageBuffer);

    const fileStats = statSync(filePath);

    // Create records
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
    // Détruire l'instance UNIQUEMENT si c'est une instance temporaire
    if (vastInstanceId && !isPersistentInstance) {
      console.log(`[job:${jobId}] Destroying instance #${vastInstanceId}...`);
      await destroyInstance(vastInstanceId).catch((err) => {
        console.error(`[job:${jobId}] Failed to destroy instance ${vastInstanceId}:`, err);
      });
    } else if (isPersistentInstance) {
      console.log(`[job:${jobId}] Keeping persistent instance #${vastInstanceId}`);
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
      cfgScale: body.cfgScale,
      sampler: body.sampler,
      scheduler: body.scheduler,
      seed: body.seed ?? null,
    },
  });

  // Fire and forget — don't await
  processJob(job.id, body.instanceId);

  return c.json({ jobId: job.id }, 202);
});

async function processImg2ImgJob(jobId: string, persistentInstanceId?: string) {
  let vastInstanceId: number | null = null;
  let isPersistentInstance = false;
  const jobStart = Date.now();

  try {
    let host: string;
    let port: string;

    if (persistentInstanceId) {
      console.log(`[img2img:${jobId}] Using persistent instance ${persistentInstanceId}...`);
      const instance = await prisma.vastInstance.findUnique({
        where: { id: persistentInstanceId },
      });

      if (!instance || instance.status !== 'RUNNING' || !instance.host || !instance.port) {
        throw new Error('Persistent instance not available');
      }

      host = instance.host;
      port = instance.port;
      vastInstanceId = Number(instance.vastInstanceId);
      isPersistentInstance = true;

      await prisma.vastInstance.update({
        where: { id: persistentInstanceId },
        data: { lastUsedAt: new Date() },
      });

      await prisma.generationJob.update({
        where: { id: jobId },
        data: {
          status: 'GENERATING',
          vastInstanceId: instance.vastInstanceId,
          instanceId: persistentInstanceId,
        },
      });
    } else {
      let stepStart = Date.now();
      console.log(`[img2img:${jobId}] Searching for GPU offer...`);
      const offer = await findCheapOffer();
      console.log(
        `[img2img:${jobId}] Found offer #${offer.id}: ${offer.gpu_name} [${elapsed(stepStart)}]`
      );

      stepStart = Date.now();
      const instanceId = await createInstance(offer.id);
      vastInstanceId = instanceId;
      console.log(`[img2img:${jobId}] Instance #${instanceId} created [${elapsed(stepStart)}]`);

      await prisma.generationJob.update({
        where: { id: jobId },
        data: { status: 'PROVISIONING', vastInstanceId: String(instanceId) },
      });

      stepStart = Date.now();
      const instance = await pollUntilReady(instanceId);
      const endpoint = getInstanceEndpoint(instance);
      host = endpoint.host;
      port = endpoint.port;
      console.log(`[img2img:${jobId}] Instance ready at ${host}:${port} [${elapsed(stepStart)}]`);

      await prisma.generationJob.update({
        where: { id: jobId },
        data: { status: 'GENERATING' },
      });
    }

    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } });

    if (!job.sourceImagePath || job.denoiseStrength === null) {
      throw new Error('Job is missing sourceImagePath or denoiseStrength');
    }

    // Upload source image to ComfyUI
    console.log(`[img2img:${jobId}] Uploading source image to ComfyUI...`);
    const sourceBuffer = readFileSync(job.sourceImagePath);
    const comfyFilename = await uploadImageToComfy(host, port, sourceBuffer, `source_${jobId}.png`);
    console.log(`[img2img:${jobId}] Source image uploaded as ${comfyFilename}`);

    // Generate
    const stepStart = Date.now();
    console.log(`[img2img:${jobId}] Sending img2img prompt to ComfyUI...`);
    const outputFilename = await generateImg2Img(host, port, {
      prompt: job.prompt,
      negativePrompt: job.negativePrompt ?? undefined,
      steps: job.steps,
      cfgScale: job.cfgScale,
      sampler: job.sampler,
      scheduler: job.scheduler,
      denoiseStrength: job.denoiseStrength,
      seed: job.seed !== null ? Number(job.seed) : undefined,
      comfyImageFilename: comfyFilename,
    });
    console.log(`[img2img:${jobId}] Image generated: ${outputFilename} [${elapsed(stepStart)}]`);

    // Download
    const downloadStart = Date.now();
    console.log(`[img2img:${jobId}] Downloading image...`);
    const imageBuffer = await downloadImage(host, port, outputFilename);
    console.log(
      `[img2img:${jobId}] Downloaded ${(imageBuffer.length / 1024).toFixed(0)}KB [${elapsed(downloadStart)}]`
    );

    // Save
    const storagePath = env.IMAGES_STORAGE_PATH;
    if (!existsSync(storagePath)) mkdirSync(storagePath, { recursive: true });

    const filename = `${jobId}.png`;
    const filePath = join(storagePath, filename);
    writeFileSync(filePath, imageBuffer);
    const fileStats = statSync(filePath);

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

    await prisma.generationJob.update({ where: { id: jobId }, data: { status: 'COMPLETED' } });
    console.log(`[img2img:${jobId}] ✓ Completed [total: ${elapsed(jobStart)}]`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[img2img:${jobId}] ✗ Failed after ${elapsed(jobStart)}: ${message}`);
    await prisma.generationJob
      .update({ where: { id: jobId }, data: { status: 'FAILED', errorMessage: message } })
      .catch(() => {});
  } finally {
    if (vastInstanceId && !isPersistentInstance) {
      await destroyInstance(vastInstanceId).catch(() => {});
    }
  }
}

app.post('/img2img', async (c) => {
  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ error: 'Request must be multipart/form-data' }, 422);
  }

  const prompt = formData.get('prompt');
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return c.json({ error: 'prompt is required' }, 422);
  }

  // Source image: uploaded file or existing job
  const storagePath = env.IMAGES_STORAGE_PATH;
  let sourceImagePath: string;

  const imageFile = formData.get('image');
  const sourceJobId = formData.get('sourceJobId');

  if (imageFile && imageFile instanceof File) {
    // Save uploaded file to disk
    if (!existsSync(storagePath)) mkdirSync(storagePath, { recursive: true });
    const uploadId = crypto.randomUUID();
    sourceImagePath = join(storagePath, `upload_${uploadId}.png`);
    writeFileSync(sourceImagePath, Buffer.from(await imageFile.arrayBuffer()));
  } else if (sourceJobId && typeof sourceJobId === 'string') {
    const sourceJob = await prisma.generationJob.findUnique({
      where: { id: sourceJobId },
      include: { image: true },
    });
    if (!sourceJob?.image) {
      return c.json({ error: 'Source job not found or has no image' }, 404);
    }
    sourceImagePath = sourceJob.image.path;
  } else {
    return c.json({ error: 'Provide either image (file) or sourceJobId' }, 422);
  }

  const denoiseStrength = Number(formData.get('denoiseStrength') ?? 0.75);
  const steps = Number(formData.get('steps') ?? 20);
  const cfgScale = Number(formData.get('cfgScale') ?? 7);
  const sampler = String(formData.get('sampler') ?? 'euler');
  const scheduler = String(formData.get('scheduler') ?? 'normal');
  const seedRaw = formData.get('seed');
  const seed = seedRaw ? Number(seedRaw) : null;
  const negativePrompt = formData.get('negativePrompt');
  const instanceId = formData.get('instanceId');

  const job = await prisma.generationJob.create({
    data: {
      prompt: prompt.trim(),
      negativePrompt: negativePrompt && typeof negativePrompt === 'string' ? negativePrompt : null,
      width: Number(formData.get('width') ?? 1024),
      height: Number(formData.get('height') ?? 1024),
      steps,
      cfgScale,
      sampler,
      scheduler,
      seed,
      denoiseStrength,
      sourceImagePath,
    },
  });

  processImg2ImgJob(job.id, instanceId && typeof instanceId === 'string' ? instanceId : undefined);

  return c.json({ jobId: job.id }, 202);
});

export default app;
