import { existsSync, unlinkSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../app.js';
import { prisma } from '../lib/prisma.js';
import { createImage, createJob } from './helpers.js';

const mockExistsSync = vi.mocked(existsSync, true);
const mockUnlinkSync = vi.mocked(unlinkSync, true);

describe('GET /api/v1/images', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return a list of images', async () => {
    const job = await createJob({ prompt: 'test' });
    const image = await createImage({ jobId: job.id, filename: 'test.png' });

    const res = await app.request('/api/v1/images');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toEqual({
      id: image.id,
      filename: 'test.png',
      sizeBytes: 1024,
      width: 1024,
      height: 1024,
      jobId: job.id,
      createdAt: image.createdAt.toISOString(),
    });
  });

  it('should return empty array when no images', async () => {
    const res = await app.request('/api/v1/images');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });
});

describe('GET /api/v1/images/:filename', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should serve an image file', async () => {
    mockExistsSync.mockReturnValue(true);

    const res = await app.request('/api/v1/images/job-1.png');

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  it('should return 404 for missing image file', async () => {
    mockExistsSync.mockReturnValue(false);

    const res = await app.request('/api/v1/images/nonexistent.png');

    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/v1/images/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should delete image from disk and DB', async () => {
    const job = await createJob({ prompt: 'test' });
    const image = await createImage({
      jobId: job.id,
      filename: 'test.png',
      path: '/tmp/test-images/test.png',
    });
    mockExistsSync.mockReturnValue(true);

    const res = await app.request(`/api/v1/images/${image.id}`, { method: 'DELETE' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ message: 'Image deleted' });
    expect(mockUnlinkSync).toHaveBeenCalledWith('/tmp/test-images/test.png');

    // Verify image was deleted from database
    const deletedImage = await prisma.generatedImage.findUnique({
      where: { id: image.id },
    });
    expect(deletedImage).toBeNull();
  });

  it('should return 404 for non-existent image', async () => {
    const res = await app.request('/api/v1/images/nonexistent-id-12345', { method: 'DELETE' });

    expect(res.status).toBe(404);
  });
});
