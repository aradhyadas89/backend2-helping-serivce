import request from 'supertest';
import { createApp } from '../src/app';

const app = createApp();

describe('Health and System Status Probes', () => {
  it('GET / should return 200 with service metadata', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('Helping Services Sub-Backend');
    expect(res.body.status).toBe('operational');
  });

  it('GET /api/v1/health should return 200 healthy status', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('healthy');
    expect(res.body.database.status).toBe('connected');
    expect(res.body.buffers).toBeDefined();
    expect(res.body.system).toBeDefined();
  });

  it('GET /unknown-route should return 404 formatted error', async () => {
    const res = await request(app).get('/api/v1/non-existent-endpoint');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe(404);
  });
});

