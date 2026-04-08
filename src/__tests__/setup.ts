import 'dotenv/config';
import { vi } from 'vitest';

// Set default test environment variables if not present
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
process.env.VAST_AI_API_KEY = process.env.VAST_AI_API_KEY || 'test-api-key';
process.env.IMAGES_STORAGE_PATH = process.env.IMAGES_STORAGE_PATH || '/tmp/test-images';

// Mock Vast.ai — never make real API calls in tests
vi.mock('../lib/vast.js', () => ({
  findCheapOffer: vi.fn().mockResolvedValue({
    id: 12345,
    gpu_name: 'RTX 4090',
    num_gpus: 1,
    gpu_ram: 24000,
    dph_total: 0.25,
    reliability: 0.99,
  }),
  createInstance: vi.fn().mockResolvedValue(67890),
  getInstance: vi.fn().mockResolvedValue({
    id: 67890,
    actual_status: 'running',
    public_ipaddr: '1.2.3.4',
    ports: { '18188/tcp': [{ HostPort: '45678' }] },
  }),
  pollUntilReady: vi.fn().mockResolvedValue({
    id: 67890,
    actual_status: 'running',
    public_ipaddr: '1.2.3.4',
    ports: { '18188/tcp': [{ HostPort: '45678' }] },
  }),
  getInstanceEndpoint: vi.fn().mockReturnValue({ host: '1.2.3.4', port: '45678' }),
  generateImage: vi.fn().mockResolvedValue('output_00001_.png'),
  downloadImage: vi.fn().mockResolvedValue(Buffer.from('fake-png-data')),
  destroyInstance: vi.fn().mockResolvedValue(undefined),
}));

// Mock Prisma
vi.mock('../lib/prisma.js', () => {
  const mockPrisma = {
    generationJob: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    generatedImage: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
    },
  };
  return { prisma: mockPrisma };
});

// Mock fs operations
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
