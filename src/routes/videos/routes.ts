import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { env } from '../../config/env.js';
import { defaultHook } from '../../lib/error-handler.js';
import { prisma } from '../../lib/prisma.js';

const app = new OpenAPIHono({ defaultHook });

const videoResponseSchema = z.object({
  id: z.string(),
  filename: z.string(),
  sizeBytes: z.number(),
  width: z.number(),
  height: z.number(),
  fps: z.number(),
  frames: z.number(),
  jobId: z.string(),
  createdAt: z.string().datetime(),
});

const listVideosRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Videos'],
  summary: 'List all generated videos',
  responses: {
    200: {
      description: 'List of videos',
      content: { 'application/json': { schema: z.array(videoResponseSchema) } },
    },
  },
});

const getVideoRoute = createRoute({
  method: 'get',
  path: '/{filename}',
  tags: ['Videos'],
  summary: 'Serve a video file',
  request: { params: z.object({ filename: z.string() }) },
  responses: {
    200: { description: 'MP4 video file' },
    404: {
      description: 'Not found',
      content: { 'application/json': { schema: z.object({ error: z.string() }) } },
    },
  },
});

const deleteVideoRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Videos'],
  summary: 'Delete a video',
  request: { params: z.object({ id: z.string() }) },
  responses: {
    200: {
      description: 'Deleted',
      content: { 'application/json': { schema: z.object({ message: z.string() }) } },
    },
    404: {
      description: 'Not found',
      content: { 'application/json': { schema: z.object({ error: z.string() }) } },
    },
  },
});

app.openapi(listVideosRoute, async (c) => {
  const videos = await prisma.generatedVideo.findMany({ orderBy: { createdAt: 'desc' } });

  return c.json(
    videos.map((v) => ({
      id: v.id,
      filename: v.filename,
      sizeBytes: v.sizeBytes,
      width: v.width,
      height: v.height,
      fps: v.fps,
      frames: v.frames,
      jobId: v.jobId,
      createdAt: v.createdAt.toISOString(),
    })),
    200
  );
});

app.openapi(getVideoRoute, async (c) => {
  const { filename } = c.req.valid('param');
  const filePath = join(env.IMAGES_STORAGE_PATH, filename);

  if (!existsSync(filePath)) {
    return c.json({ error: 'Video not found' }, 404);
  }

  const buffer = readFileSync(filePath);
  return c.newResponse(buffer, 200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
});

app.openapi(deleteVideoRoute, async (c) => {
  const { id } = c.req.valid('param');
  const video = await prisma.generatedVideo.findUnique({ where: { id } });

  if (!video) {
    return c.json({ error: 'Video not found' }, 404);
  }

  if (existsSync(video.path)) {
    unlinkSync(video.path);
  }

  await prisma.generatedVideo.delete({ where: { id } });

  return c.json({ message: 'Video deleted' }, 200);
});

export default app;
