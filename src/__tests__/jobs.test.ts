import { describe, expect, it } from 'vitest';
import app from '../app.js';
import { createImage, createJob } from './helpers.js';

describe('GET /api/v1/jobs/:id', () => {
  it('should return job details when found (pending, no image)', async () => {
    const job = await createJob({ prompt: 'a sunset', status: 'PENDING' });

    const res = await app.request(`/api/v1/jobs/${job.id}`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      id: job.id,
      prompt: 'a sunset',
      negativePrompt: null,
      width: 1024,
      height: 1024,
      steps: 20,
      status: 'PENDING',
      errorMessage: null,
      imageUrl: null,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    });
  });

  it('should return imageUrl when job is completed', async () => {
    const job = await createJob({
      prompt: 'a cat',
      status: 'COMPLETED',
      vastInstanceId: '67890',
    });
    await createImage({ jobId: job.id, filename: `${job.id}.png` });

    const res = await app.request(`/api/v1/jobs/${job.id}`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('COMPLETED');
    expect(body.imageUrl).toBe(`http://localhost:3000/api/v1/images/${job.id}.png`);
  });

  it('should return errorMessage when job failed', async () => {
    const job = await createJob({
      prompt: 'test',
      status: 'FAILED',
      vastInstanceId: '67890',
      errorMessage: 'No suitable GPU offers found',
    });

    const res = await app.request(`/api/v1/jobs/${job.id}`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('FAILED');
    expect(body.errorMessage).toBe('No suitable GPU offers found');
  });

  it('should return 404 for non-existent job', async () => {
    const res = await app.request('/api/v1/jobs/nonexistent-id-12345');

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'Job not found' });
  });
});
