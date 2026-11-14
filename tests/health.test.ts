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

  it('GET /ping and /live-ping should return fast 200 pong status', async () => {
    const pingRes = await request(app).get('/ping');
    expect(pingRes.status).toBe(200);
    expect(pingRes.body.success).toBe(true);
    expect(pingRes.body.ping).toBe('pong');
    expect(pingRes.body.status).toBe('live');
    expect(pingRes.body.uptimeSeconds).toBeGreaterThanOrEqual(0);

    const livePingRes = await request(app).get('/live-ping');
    expect(livePingRes.status).toBe(200);
    expect(livePingRes.body.ping).toBe('pong');

    const healthPingRes = await request(app).get('/api/v1/health/ping');
    expect(healthPingRes.status).toBe(200);
    expect(healthPingRes.body.ping).toBe('pong');
    expect(healthPingRes.body.status).toBe('live');
  });

  it('GET /unknown-route should return 404 formatted error', async () => {
    const res = await request(app).get('/api/v1/non-existent-endpoint');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe(404);
  });
});

