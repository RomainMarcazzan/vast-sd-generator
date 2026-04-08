import { createRoute, z } from '@hono/zod-openapi';
import { imageListResponseSchema } from '../../schemas/generation.js';

export const listImagesRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Images'],
  summary: 'List all generated images',
  responses: {
    200: {
      description: 'List of images',
      content: {
        'application/json': {
          schema: imageListResponseSchema,
        },
      },
    },
  },
});

export const getImageRoute = createRoute({
  method: 'get',
  path: '/{filename}',
  tags: ['Images'],
  summary: 'Serve an image file',
  request: {
    params: z.object({ filename: z.string() }),
  },
  responses: {
    200: {
      description: 'Image file',
      content: {
        'image/png': {
          schema: z.string(),
        },
      },
    },
    404: {
      description: 'Image not found',
      content: {
        'application/json': {
          schema: z.object({ error: z.string() }),
        },
      },
    },
  },
});

export const deleteImageRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Images'],
  summary: 'Delete an image',
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'Image deleted',
      content: {
        'application/json': {
          schema: z.object({ message: z.string() }),
        },
      },
    },
    404: {
      description: 'Image not found',
      content: {
        'application/json': {
          schema: z.object({ error: z.string() }),
        },
      },
    },
  },
});
