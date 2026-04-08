import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { OpenAPIHono } from '@hono/zod-openapi';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { deleteImageRoute, getImageRoute, listImagesRoute } from './definitions.js';

const app = new OpenAPIHono();

app.openapi(listImagesRoute, async (c) => {
  const images = await prisma.generatedImage.findMany({
    orderBy: { createdAt: 'desc' },
  });

  return c.json(
    images.map((img) => ({
      id: img.id,
      filename: img.filename,
      sizeBytes: img.sizeBytes,
      width: img.width,
      height: img.height,
      jobId: img.jobId,
      createdAt: img.createdAt.toISOString(),
    })),
    200
  );
});

app.openapi(getImageRoute, async (c) => {
  const { filename } = c.req.valid('param');
  const filePath = join(env.IMAGES_STORAGE_PATH, filename);

  if (!existsSync(filePath)) {
    return c.json({ error: 'Image not found' }, 404);
  }

  const buffer = readFileSync(filePath);
  return c.newResponse(buffer, 200, {
    'Content-Type': 'image/png',
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
});

app.openapi(deleteImageRoute, async (c) => {
  const { id } = c.req.valid('param');

  const image = await prisma.generatedImage.findUnique({ where: { id } });

  if (!image) {
    return c.json({ error: 'Image not found' }, 404);
  }

  // Delete file from disk
  if (existsSync(image.path)) {
    unlinkSync(image.path);
  }

  // Delete DB record
  await prisma.generatedImage.delete({ where: { id } });

  return c.json({ message: 'Image deleted' }, 200);
});

export default app;
