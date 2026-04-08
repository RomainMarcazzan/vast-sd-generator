import { createRoute, z } from '@hono/zod-openapi';
import { jobResponseSchema } from '../../schemas/generation.js';

export const getJobRoute = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Jobs'],
  summary: 'Get job status',
  request: {
    params: z.object({ id: z.string() }),
  },
  responses: {
    200: {
      description: 'Job details',
      content: {
        'application/json': {
          schema: jobResponseSchema,
        },
      },
    },
    404: {
      description: 'Job not found',
      content: {
        'application/json': {
          schema: z.object({ error: z.string() }),
        },
      },
    },
  },
});
