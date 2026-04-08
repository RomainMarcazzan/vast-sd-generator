import { execSync } from 'node:child_process';
import { afterAll, beforeAll, beforeEach, vi } from 'vitest';
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

// Setup: run migrations once before all tests
beforeAll(async () => {
  console.log('Setting up test database...');
  try {
    execSync('npx prisma migrate deploy', {
      env: process.env,
      stdio: 'inherit',
    });
    console.log('Migrations applied successfully');
  } catch (error) {
    console.error('Failed to apply migrations:', error);
    throw error;
  }
});

// Reset database before each test
beforeEach(async () => {
  // Delete in correct order due to foreign keys
  await prisma.generatedImage.deleteMany();
  await prisma.generationJob.deleteMany();
});

// Cleanup after all tests
afterAll(async () => {
  await prisma.$disconnect();
});
