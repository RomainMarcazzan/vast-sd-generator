import { describe, expect, it } from 'vitest';
import app from '../app.js';
import { prisma } from '../lib/prisma.js';

describe('POST /api/v1/generate', () => {
  it('should create a job and return 202 with jobId', async () => {
    const res = await app.request('/api/v1/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'a sunset' }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toHaveProperty('jobId');

    // Verify job was created in database
    const job = await prisma.generationJob.findUnique({
      where: { id: body.jobId },
    });
    expect(job).not.toBeNull();
    expect(job?.prompt).toBe('a sunset');
    expect(job?.status).toBe('PENDING');
    expect(job?.width).toBe(1024);
    expect(job?.height).toBe(1024);
    expect(job?.steps).toBe(20);
  });

  it('should accept all optional parameters', async () => {
    const res = await app.request('/api/v1/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'a cat',
        negativePrompt: 'blurry',
        width: 512,
        height: 768,
        steps: 30,
      }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();

    const job = await prisma.generationJob.findUnique({
      where: { id: body.jobId },
    });
    expect(job?.prompt).toBe('a cat');
    expect(job?.negativePrompt).toBe('blurry');
    expect(job?.width).toBe(512);
    expect(job?.height).toBe(768);
    expect(job?.steps).toBe(30);
  });

  it('should return 422 for empty prompt', async () => {
    const res = await app.request('/api/v1/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '' }),
    });

    expect(res.status).toBe(422);
  });

  it('should return 422 for missing prompt', async () => {
    const res = await app.request('/api/v1/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(422);
  });

  it('should return 422 for invalid dimensions', async () => {
    const res = await app.request('/api/v1/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'test', width: 100 }),
    });

    expect(res.status).toBe(422);
  });
});
