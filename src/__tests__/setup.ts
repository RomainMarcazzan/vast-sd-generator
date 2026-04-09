import { afterAll, beforeEach, vi } from 'vitest';
import { prisma } from '../lib/prisma.js';

// Mock fs operations for image tests
vi.mock('node:fs', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn().mockReturnValue(Buffer.from('fake-png-data')),
    unlinkSync: vi.fn(),
    statSync: vi.fn().mockReturnValue({ size: 1024 }),
  };
});

// Reset database before each test
beforeEach(async () => {
  // Delete in correct order due to foreign keys
  await prisma.generatedImage.deleteMany();
  await prisma.generationJob.deleteMany();
  await prisma.vastInstance.deleteMany();
});

// Cleanup after all tests
afterAll(async () => {
  await prisma.$disconnect();
});
