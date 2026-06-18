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
  downloadVideo,
  findGpuOffer,
  generateImage,
  generateVideo,
  generateVideoI2V,
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
      const offer = await findGpuOffer(12000, 'cheapest', 1.5, 50);
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

async function processVideoJob(jobId: string, persistentInstanceId?: string) {
  let vastInstanceId: number | null = null;
  let isPersistentInstance = false;
  const jobStart = Date.now();

  try {
    let host: string;
    let port: string;

    if (persistentInstanceId) {
      console.log(`[video:${jobId}] Using persistent instance ${persistentInstanceId}...`);
      const instance = await prisma.vastInstance.findUnique({
        where: { id: persistentInstanceId },
      });

      if (!instance || instance.status !== 'RUNNING' || !instance.host || !instance.port) {
        throw new Error('Persistent instance not available');
      }
      if (instance.type !== 'VIDEO') {
        throw new Error('Instance type must be VIDEO for video generation');
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
      console.log(`[video:${jobId}] Searching for GPU offer (VIDEO, 24GB VRAM)...`);
      const offer = await findGpuOffer(24000, 'fastest', 2, 100);
      console.log(
        `[video:${jobId}] Found offer #${offer.id}: ${offer.gpu_name} [${elapsed(stepStart)}]`
      );

      stepStart = Date.now();
      const instanceId = await createInstance(offer.id, 'VIDEO');
      vastInstanceId = instanceId;
      console.log(`[video:${jobId}] Instance #${instanceId} created [${elapsed(stepStart)}]`);

      await prisma.generationJob.update({
        where: { id: jobId },
        data: { status: 'PROVISIONING', vastInstanceId: String(instanceId) },
      });

      stepStart = Date.now();
      const instance = await pollUntilReady(instanceId);
      const endpoint = getInstanceEndpoint(instance);
      host = endpoint.host;
      port = endpoint.port;
      console.log(`[video:${jobId}] Instance ready at ${host}:${port} [${elapsed(stepStart)}]`);

      await prisma.generationJob.update({ where: { id: jobId }, data: { status: 'GENERATING' } });
    }

    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } });

    const stepStart = Date.now();
    console.log(`[video:${jobId}] Sending prompt to ComfyUI (Wan 2.2 T2V)...`);
    const outputFilename = await generateVideo(host, port, {
      prompt: job.prompt,
      negativePrompt: job.negativePrompt ?? undefined,
      width: job.width,
      height: job.height,
      frames: job.frames,
      steps: job.steps,
      cfgScale: job.cfgScale,
      seed: job.seed !== null ? Number(job.seed) : undefined,
    });
    console.log(`[video:${jobId}] Video generated: ${outputFilename} [${elapsed(stepStart)}]`);

    const downloadStart = Date.now();
    console.log(`[video:${jobId}] Downloading video...`);
    const videoBuffer = await downloadVideo(host, port, outputFilename);
    console.log(
      `[video:${jobId}] Downloaded ${(videoBuffer.length / 1024 / 1024).toFixed(1)}MB [${elapsed(downloadStart)}]`
    );

    const storagePath = env.IMAGES_STORAGE_PATH;
    if (!existsSync(storagePath)) mkdirSync(storagePath, { recursive: true });

    const filename = `${jobId}.mp4`;
    const filePath = join(storagePath, filename);
    writeFileSync(filePath, videoBuffer);
    const fileStats = statSync(filePath);

    await prisma.generatedVideo.create({
      data: {
        filename,
        path: filePath,
        sizeBytes: fileStats.size,
        width: job.width,
        height: job.height,
        fps: 16,
        frames: 81,
        jobId,
      },
    });

    await prisma.generationJob.update({ where: { id: jobId }, data: { status: 'COMPLETED' } });
    console.log(`[video:${jobId}] ✓ Completed [total: ${elapsed(jobStart)}]`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[video:${jobId}] ✗ Failed after ${elapsed(jobStart)}: ${message}`);
    await prisma.generationJob
      .update({ where: { id: jobId }, data: { status: 'FAILED', errorMessage: message } })
      .catch(() => {});
  } finally {
    if (vastInstanceId && !isPersistentInstance) {
      await destroyInstance(vastInstanceId).catch(() => {});
    }
  }
}

async function processImg2VidJob(jobId: string, persistentInstanceId?: string) {
  let vastInstanceId: number | null = null;
  let isPersistentInstance = false;
  const jobStart = Date.now();

  try {
    let host: string;
    let port: string;

    if (persistentInstanceId) {
      console.log(`[i2v:${jobId}] Using persistent instance ${persistentInstanceId}...`);
      const instance = await prisma.vastInstance.findUnique({
        where: { id: persistentInstanceId },
      });
      if (!instance || instance.status !== 'RUNNING' || !instance.host || !instance.port) {
        throw new Error('Persistent instance not available');
      }
      if (instance.type !== 'VIDEO') {
        throw new Error('Instance type must be VIDEO for I2V');
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
      console.log(`[i2v:${jobId}] Searching for GPU offer (VIDEO, 24GB VRAM)...`);
      const offer = await findGpuOffer(24000, 'fastest', 2, 100);
      console.log(
        `[i2v:${jobId}] Found offer #${offer.id}: ${offer.gpu_name} [${elapsed(stepStart)}]`
      );

      stepStart = Date.now();
      const instanceId = await createInstance(offer.id, 'VIDEO');
      vastInstanceId = instanceId;
      console.log(`[i2v:${jobId}] Instance #${instanceId} created [${elapsed(stepStart)}]`);

      await prisma.generationJob.update({
        where: { id: jobId },
        data: { status: 'PROVISIONING', vastInstanceId: String(instanceId) },
      });

      stepStart = Date.now();
      const instance = await pollUntilReady(instanceId);
      const endpoint = getInstanceEndpoint(instance);
      host = endpoint.host;
      port = endpoint.port;
      console.log(`[i2v:${jobId}] Instance ready at ${host}:${port} [${elapsed(stepStart)}]`);

      await prisma.generationJob.update({ where: { id: jobId }, data: { status: 'GENERATING' } });
    }

    const job = await prisma.generationJob.findUniqueOrThrow({ where: { id: jobId } });
    if (!job.sourceImagePath) {
      throw new Error('No source image path for I2V job');
    }

    // Upload source image to ComfyUI
    const stepStart = Date.now();
    const imageBuffer = readFileSync(job.sourceImagePath!);
    const imageFilename = `i2v_source_${jobId}.png`;
    console.log(`[i2v:${jobId}] Uploading source image to ComfyUI...`);
    const uploadedFilename = await uploadImageToComfy(host, port, imageBuffer, imageFilename);
    console.log(
      `[i2v:${jobId}] Source image uploaded: ${uploadedFilename} [${elapsed(stepStart)}]`
    );

    // Generate video
    const genStart = Date.now();
    console.log(`[i2v:${jobId}] Sending prompt to ComfyUI (Wan 2.2 I2V)...`);
    const outputFilename = await generateVideoI2V(host, port, {
      prompt: job.prompt,
      negativePrompt: job.negativePrompt ?? undefined,
      width: job.width,
      height: job.height,
      frames: job.frames,
      steps: job.steps,
      cfgScale: job.cfgScale,
      seed: job.seed !== null ? Number(job.seed) : undefined,
      imageFilename: uploadedFilename,
    });
    console.log(`[i2v:${jobId}] Video generated: ${outputFilename} [${elapsed(genStart)}]`);

    // Download
    const downloadStart = Date.now();
    console.log(`[i2v:${jobId}] Downloading video...`);
    const videoBuffer = await downloadVideo(host, port, outputFilename);
    console.log(
      `[i2v:${jobId}] Downloaded ${(videoBuffer.length / 1024 / 1024).toFixed(1)}MB [${elapsed(downloadStart)}]`
    );

    const storagePath = env.IMAGES_STORAGE_PATH;
    if (!existsSync(storagePath)) mkdirSync(storagePath, { recursive: true });

    const filename = `${jobId}.mp4`;
    const filePath = join(storagePath, filename);
    writeFileSync(filePath, videoBuffer);
    const fileStats = statSync(filePath);

    await prisma.generatedVideo.create({
      data: {
        filename,
        path: filePath,
        sizeBytes: fileStats.size,
        width: job.width,
        height: job.height,
        fps: 16,
        frames: job.frames,
        jobId,
      },
    });

    await prisma.generationJob.update({ where: { id: jobId }, data: { status: 'COMPLETED' } });
    console.log(`[i2v:${jobId}] ✓ Completed [total: ${elapsed(jobStart)}]`);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[i2v:${jobId}] ✗ Failed after ${elapsed(jobStart)}: ${message}`);
    await prisma.generationJob
      .update({ where: { id: jobId }, data: { status: 'FAILED', errorMessage: message } })
      .catch(() => {});
  } finally {
    if (vastInstanceId && !isPersistentInstance) {
      await destroyInstance(vastInstanceId).catch(() => {});
    }
  }
}

app.post('/video', async (c) => {
  let body: {
    prompt?: unknown;
    negativePrompt?: unknown;
    width?: unknown;
    height?: unknown;
    steps?: unknown;
    cfgScale?: unknown;
    sampler?: unknown;
    scheduler?: unknown;
    seed?: unknown;
    frames?: unknown;
    instanceId?: unknown;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 422);
  }

  const prompt = body.prompt;
  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    return c.json({ error: 'prompt is required' }, 422);
  }

  const instanceId = body.instanceId;
  if (instanceId && typeof instanceId === 'string') {
    const instance = await prisma.vastInstance.findUnique({ where: { id: instanceId } });
    if (instance && instance.type !== 'VIDEO') {
      return c.json({ error: 'instanceId must reference a VIDEO instance' }, 422);
    }
  }

  const frames = Number(body.frames ?? 81);

  const job = await prisma.generationJob.create({
    data: {
      prompt: prompt.trim(),
      negativePrompt: typeof body.negativePrompt === 'string' ? body.negativePrompt : null,
      width: Number(body.width ?? 832),
      height: Number(body.height ?? 480),
      steps: Number(body.steps ?? 20),
      cfgScale: Number(body.cfgScale ?? 6),
      sampler: typeof body.sampler === 'string' ? body.sampler : 'euler',
      scheduler: typeof body.scheduler === 'string' ? body.scheduler : 'simple',
      seed: body.seed != null ? Number(body.seed) : null,
      frames,
      mediaType: 'VIDEO',
    },
  });

  processVideoJob(job.id, typeof instanceId === 'string' ? instanceId : undefined);

  return c.json({ jobId: job.id }, 202);
});

app.post('/video/img2vid', async (c) => {
  const formData = await c.req.parseBody();
  const imageFile = formData['image'] as File | undefined;
  const sourceJobId = formData['sourceJobId'] as string | undefined;
  const prompt = formData['prompt'] as string | undefined;
  const negativePrompt = formData['negativePrompt'] as string | undefined;
  const instanceId = formData['instanceId'] as string | undefined;

  if (!prompt || prompt.trim().length === 0) {
    return c.json({ error: 'prompt is required' }, 422);
  }

  if (instanceId && typeof instanceId === 'string') {
    const instance = await prisma.vastInstance.findUnique({ where: { id: instanceId } });
    if (instance && instance.type !== 'VIDEO') {
      return c.json({ error: 'instanceId must reference a VIDEO instance' }, 422);
    }
  }

  // Resolve source image
  let sourceImagePath: string;
  if (imageFile) {
    const buffer = Buffer.from(await imageFile.arrayBuffer());
    const storagePath = env.IMAGES_STORAGE_PATH;
    if (!existsSync(storagePath)) mkdirSync(storagePath, { recursive: true });
    sourceImagePath = join(storagePath, `i2v_source_${Date.now()}_${imageFile.name}`);
    writeFileSync(sourceImagePath, buffer);
  } else if (sourceJobId) {
    const srcJob = await prisma.generationJob.findUnique({
      where: { id: sourceJobId },
      include: { image: true },
    });
    if (!srcJob?.image?.path) {
      return c.json({ error: 'sourceJobId not found or has no image' }, 404);
    }
    sourceImagePath = srcJob.image.path;
  } else {
    return c.json({ error: 'image file or sourceJobId is required' }, 422);
  }

  const width = Number((formData['width'] as string) ?? 832);
  const height = Number((formData['height'] as string) ?? 480);
  const steps = Number((formData['steps'] as string) ?? 20);
  const cfgScale = Number((formData['cfgScale'] as string) ?? 6);
  const frames = Number((formData['frames'] as string) ?? 81);
  const seed = formData['seed'] ? Number(formData['seed']) : null;

  const job = await prisma.generationJob.create({
    data: {
      prompt: prompt.trim(),
      negativePrompt: negativePrompt?.trim() || null,
      width,
      height,
      steps,
      cfgScale,
      sampler: (formData['sampler'] as string) ?? 'euler',
      scheduler: (formData['scheduler'] as string) ?? 'simple',
      seed,
      frames,
      sourceImagePath,
      mediaType: 'VIDEO',
    },
  });

  processImg2VidJob(job.id, typeof instanceId === 'string' ? instanceId : undefined);

  return c.json({ jobId: job.id }, 202);
});

export default app;
