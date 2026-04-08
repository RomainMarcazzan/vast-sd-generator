import { beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../app.js';
import { prisma } from '../lib/prisma.js';

const mockPrisma = vi.mocked(prisma, true);

describe('GET /api/v1/jobs/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return job details when found (pending, no image)', async () => {
    mockPrisma.generationJob.findUnique.mockResolvedValue({
      id: 'job-1',
      prompt: 'a sunset',
      negativePrompt: null,
      width: 1024,
      height: 1024,
      steps: 20,
      status: 'PENDING',
      vastInstanceId: null,
      errorMessage: null,
      image: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      // biome-ignore lint/suspicious/noExplicitAny: mock relation type
    } as any);

    const res = await app.request('/api/v1/jobs/job-1');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      id: 'job-1',
      prompt: 'a sunset',
      negativePrompt: null,
      width: 1024,
      height: 1024,
      steps: 20,
      status: 'PENDING',
      errorMessage: null,
      imageUrl: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('should return imageUrl when job is completed', async () => {
    mockPrisma.generationJob.findUnique.mockResolvedValue({
      id: 'job-2',
      prompt: 'a cat',
      negativePrompt: null,
      width: 512,
      height: 512,
      steps: 20,
      status: 'COMPLETED',
      vastInstanceId: '67890',
      errorMessage: null,
      image: { filename: 'job-2.png' },
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:01:00Z'),
      // biome-ignore lint/suspicious/noExplicitAny: mock relation type
    } as any);

    const res = await app.request('/api/v1/jobs/job-2');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('COMPLETED');
    expect(body.imageUrl).toBe('http://localhost:3000/api/v1/images/job-2.png');
  });

  it('should return errorMessage when job failed', async () => {
    mockPrisma.generationJob.findUnique.mockResolvedValue({
      id: 'job-3',
      prompt: 'test',
      negativePrompt: null,
      width: 1024,
      height: 1024,
      steps: 20,
      status: 'FAILED',
      vastInstanceId: '67890',
      errorMessage: 'No suitable GPU offers found',
      image: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:30Z'),
      // biome-ignore lint/suspicious/noExplicitAny: mock relation type
    } as any);

    const res = await app.request('/api/v1/jobs/job-3');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('FAILED');
    expect(body.errorMessage).toBe('No suitable GPU offers found');
  });

  it('should return 404 for non-existent job', async () => {
    mockPrisma.generationJob.findUnique.mockResolvedValue(null);

    const res = await app.request('/api/v1/jobs/nonexistent');

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: 'Job not found' });
  });
});
