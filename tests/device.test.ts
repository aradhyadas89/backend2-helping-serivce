import request from 'supertest';
import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { deviceStreamService } from '../src/services/device-stream.service';

const app = createApp();
const secret = env.ADMIN_SUB_BACKEND_SECRET;

describe('Device Telemetry & Analytics Routes', () => {
  beforeEach(async () => {
    // Seed devices
    await deviceStreamService.ingestDeviceEvent({
      userId: 'dev_user_1',
      osName: 'ios',
      osVersion: '17.2',
      deviceBrand: 'Apple',
      deviceModel: 'iPhone 15 Pro',
      role: 'user',
      timestamp: new Date(),
    });

    await deviceStreamService.ingestDeviceEvent({
      userId: 'dev_user_2',
      osName: 'android',
      osVersion: '14.0',
      deviceBrand: 'Samsung',
      deviceModel: 'Galaxy S24',
      role: 'partner',
      timestamp: new Date(),
    });
  });

  it('GET /api/v1/devices/analytics should aggregate OS distribution and brands', async () => {
    const res = await request(app)
      .get('/api/v1/devices/analytics?timeframe=7d')
      .set('x-engine-secret', secret);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.totalDevicesRecorded).toBeGreaterThanOrEqual(2);
    expect(res.body.data.osDistribution).toBeDefined();
  });

  it('GET /api/v1/devices/stream should return recent event buffer', async () => {
    const res = await request(app)
      .get('/api/v1/devices/stream?limit=10')
      .set('x-engine-secret', secret);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

