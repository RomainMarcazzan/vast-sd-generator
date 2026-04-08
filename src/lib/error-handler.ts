import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { Prisma } from '../generated/prisma/client.js';

export function onErrorHandler(err: Error, c: Context) {
  if (err instanceof HTTPException) return err.getResponse();

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2025') return c.json({ error: 'Not found' }, 404);
    if (err.code === 'P2002') return c.json({ error: 'Already exists' }, 409);
    return c.json({ error: 'Database error' }, 500);
  }

  if (err instanceof Prisma.PrismaClientInitializationError) {
    return c.json({ error: 'Database unavailable' }, 503);
  }

  console.error({ requestId: c.get('requestId'), error: err });
  return c.json({ error: 'Internal Server Error' }, 500);
}

export function defaultHook(
  result: { success: boolean; error?: { flatten: () => unknown } },
  c: Context
) {
  if (!result.success) {
    return c.json({ error: 'Validation error', details: result.error?.flatten() }, 422);
  }
}
