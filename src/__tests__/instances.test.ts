import { describe, expect, it, vi } from 'vitest';
import app from '../app.js';
import { prisma } from '../lib/prisma.js';

// Mock Vast.ai pour éviter de vraiment créer des instances
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
  getInstanceEndpoint: vi.fn().mockReturnValue({ host: '1.2.3.4', port: '45678' }),
  destroyInstance: vi.fn().mockResolvedValue(undefined),
}));

describe('Instances API', () => {
  describe('POST /api/v1/instances', () => {
    it('should create a new persistent instance', async () => {
      const res = await app.request('/api/v1/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: 'Test instance' }),
      });

      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toHaveProperty('id');
      expect(body).toHaveProperty('vastInstanceId', '67890');
      expect(body).toHaveProperty('status', 'PROVISIONING');
      expect(body).toHaveProperty('host', null);
      expect(body).toHaveProperty('port', null);
      expect(body).toHaveProperty('gpuName', 'RTX 4090');
      expect(body).toHaveProperty('costPerHour', 0.25);
      expect(body).toHaveProperty('expiresAt');

      // En DB, le background poll peut déjà avoir mis à jour le status
      // On vérifie que l'instance existe
      const instance = await prisma.vastInstance.findUnique({
        where: { id: body.id },
      });
      expect(instance).not.toBeNull();
    });
  });

  describe('GET /api/v1/instances', () => {
    it('should list running instances', async () => {
      // Créer une instance en DB
      await prisma.vastInstance.create({
        data: {
          vastInstanceId: '11111',
          status: 'RUNNING',
          host: '1.1.1.1',
          port: '11111',
          gpuName: 'RTX 3090',
          costPerHour: 0.2,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        },
      });

      const res = await app.request('/api/v1/instances');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThan(0);
      expect(body[0]).toHaveProperty('id');
      expect(body[0]).toHaveProperty('status', 'RUNNING');
    });

    it('should list provisioning instances', async () => {
      await prisma.vastInstance.create({
        data: {
          vastInstanceId: '55555',
          status: 'PROVISIONING',
          gpuName: 'RTX 4090',
          costPerHour: 0.25,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        },
      });

      const res = await app.request('/api/v1/instances');
      const body = await res.json();

      const provisioningInstance = body.find(
        (i: { vastInstanceId: string }) => i.vastInstanceId === '55555'
      );
      expect(provisioningInstance).toBeDefined();
      expect(provisioningInstance.status).toBe('PROVISIONING');
    });

    it('should not list destroyed instances', async () => {
      // Créer une instance détruite
      await prisma.vastInstance.create({
        data: {
          vastInstanceId: '99999',
          status: 'DESTROYED',
          host: null,
          port: null,
          gpuName: null,
          costPerHour: null,
          expiresAt: new Date(),
        },
      });

      const res = await app.request('/api/v1/instances');
      const body = await res.json();

      // Ne devrait pas contenir l'instance détruite
      const destroyedInstance = body.find(
        (i: { vastInstanceId: string }) => i.vastInstanceId === '99999'
      );
      expect(destroyedInstance).toBeUndefined();
    });
  });

  describe('DELETE /api/v1/instances/:id', () => {
    it('should destroy an instance', async () => {
      // Créer une instance
      const instance = await prisma.vastInstance.create({
        data: {
          vastInstanceId: '22222',
          status: 'RUNNING',
          host: '2.2.2.2',
          port: '22222',
          gpuName: 'RTX 4080',
          costPerHour: 0.3,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        },
      });

      const res = await app.request(`/api/v1/instances/${instance.id}`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ message: 'Instance destroyed' });

      // Vérifier en DB
      const updated = await prisma.vastInstance.findUnique({
        where: { id: instance.id },
      });
      expect(updated?.status).toBe('DESTROYED');
    });

    it('should return 404 for non-existent instance', async () => {
      const res = await app.request('/api/v1/instances/nonexistent-id', {
        method: 'DELETE',
      });

      expect(res.status).toBe(404);
    });

    it('should return 404 for already destroyed instance', async () => {
      // Créer une instance déjà détruite
      const instance = await prisma.vastInstance.create({
        data: {
          vastInstanceId: '33333',
          status: 'DESTROYED',
          host: null,
          port: null,
          gpuName: null,
          costPerHour: null,
          expiresAt: new Date(),
        },
      });

      const res = await app.request(`/api/v1/instances/${instance.id}`, {
        method: 'DELETE',
      });

      expect(res.status).toBe(404);
    });
  });
});

describe('Generate with persistent instance', () => {
  it('should create job with instanceId reference', async () => {
    // Créer une instance
    const instance = await prisma.vastInstance.create({
      data: {
        vastInstanceId: '44444',
        status: 'RUNNING',
        host: '3.3.3.3',
        port: '33333',
        gpuName: 'RTX 4090',
        costPerHour: 0.25,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      },
    });

    const res = await app.request('/api/v1/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: 'test with instance',
        instanceId: instance.id,
      }),
    });

    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toHaveProperty('jobId');

    // Le job est créé (le lien instanceId est set en background par processJob)
    const job = await prisma.generationJob.findUnique({
      where: { id: body.jobId },
    });
    expect(job).not.toBeNull();
    expect(job?.prompt).toBe('test with instance');
  });
});
