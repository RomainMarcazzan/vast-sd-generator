import { beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../app.js';
import { prisma } from '../lib/prisma.js';

const mockPrisma = vi.mocked(prisma, true);

describe('POST /api/v1/generate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create a job and return 202 with jobId', async () => {
    mockPrisma.generationJob.create.mockResolvedValue({
      id: 'test-job-id',
      prompt: 'a sunset',
      negativePrompt: null,
      width: 1024,
      height: 1024,
      steps: 20,
      status: 'PENDING',
      vastInstanceId: null,
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await app.request('/api/v1/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'a sunset' }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toEqual({ jobId: 'test-job-id' });
    expect(mockPrisma.generationJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ prompt: 'a sunset' }),
    });
  });

  it('should accept all optional parameters', async () => {
    mockPrisma.generationJob.create.mockResolvedValue({
      id: 'test-job-id-2',
      prompt: 'a cat',
      negativePrompt: 'blurry',
      width: 512,
      height: 768,
      steps: 30,
      status: 'PENDING',
      vastInstanceId: null,
      errorMessage: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

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
    expect(mockPrisma.generationJob.create).toHaveBeenCalledWith({
      data: {
        prompt: 'a cat',
        negativePrompt: 'blurry',
        width: 512,
        height: 768,
        steps: 30,
      },
    });
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
