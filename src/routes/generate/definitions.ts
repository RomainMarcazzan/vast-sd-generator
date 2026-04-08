import { createRoute, z } from '@hono/zod-openapi';
import { generateRequestSchema } from '../../schemas/generation.js';

export const generateRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Generation'],
  summary: 'Submit an image generation job',
  request: {
    body: {
      content: {
        'application/json': {
          schema: generateRequestSchema,
        },
      },
    },
  },
  responses: {
    202: {
      description: 'Job created',
      content: {
        'application/json': {
          schema: z.object({ jobId: z.string() }),
        },
      },
    },
    422: {
      description: 'Validation error',
      content: {
        'application/json': {
          schema: z.object({
            error: z.string(),
            details: z.unknown().optional(),
          }),
        },
      },
    },
  },
});
