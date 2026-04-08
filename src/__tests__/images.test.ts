import { existsSync, unlinkSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../app.js';
import { prisma } from '../lib/prisma.js';

const mockPrisma = vi.mocked(prisma, true);
const mockExistsSync = vi.mocked(existsSync, true);
const mockUnlinkSync = vi.mocked(unlinkSync, true);

describe('GET /api/v1/images', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return a list of images', async () => {
    mockPrisma.generatedImage.findMany.mockResolvedValue([
      {
        id: 'img-1',
        filename: 'job-1.png',
        path: './data/images/job-1.png',
        sizeBytes: 1024,
        width: 1024,
        height: 1024,
        jobId: 'job-1',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);

    const res = await app.request('/api/v1/images');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toEqual({
      id: 'img-1',
      filename: 'job-1.png',
      sizeBytes: 1024,
      width: 1024,
      height: 1024,
      jobId: 'job-1',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('should return empty array when no images', async () => {
    mockPrisma.generatedImage.findMany.mockResolvedValue([]);

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
    mockPrisma.generatedImage.findUnique.mockResolvedValue({
      id: 'img-1',
      filename: 'job-1.png',
      path: './data/images/job-1.png',
      sizeBytes: 1024,
      width: 1024,
      height: 1024,
      jobId: 'job-1',
      createdAt: new Date(),
    });
    // biome-ignore lint/suspicious/noExplicitAny: mock return type
    mockPrisma.generatedImage.delete.mockResolvedValue({} as any);
    mockExistsSync.mockReturnValue(true);

    const res = await app.request('/api/v1/images/img-1', { method: 'DELETE' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ message: 'Image deleted' });
    expect(mockUnlinkSync).toHaveBeenCalledWith('./data/images/job-1.png');
    expect(mockPrisma.generatedImage.delete).toHaveBeenCalledWith({ where: { id: 'img-1' } });
  });

  it('should return 404 for non-existent image', async () => {
    mockPrisma.generatedImage.findUnique.mockResolvedValue(null);

    const res = await app.request('/api/v1/images/nonexistent', { method: 'DELETE' });

    expect(res.status).toBe(404);
  });
});
