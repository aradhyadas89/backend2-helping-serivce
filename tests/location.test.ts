import request from 'supertest';
import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { locationStreamService } from '../src/services/location-stream.service';

const app = createApp();
const secret = env.ADMIN_SUB_BACKEND_SECRET;

describe('Location & Geofencing Routes', () => {
  beforeEach(async () => {
    // Seed test location events
    await locationStreamService.ingestLocationEvent({
      userId: 'loc_user_01',
      userName: 'Alice',
      role: 'partner',
      latitude: 22.5726,
      longitude: 88.3639,
      speed: 5.0,
      timestamp: new Date(),
    });

    await locationStreamService.ingestLocationEvent({
      userId: 'loc_user_02',
      userName: 'Bob',
      role: 'user',
      latitude: 22.5800,
      longitude: 88.3700,
      timestamp: new Date(),
    });
  });

  it('GET /api/v1/locations/live should return live user positions', async () => {
    const res = await request(app)
      .get('/api/v1/locations/live')
      .set('x-engine-secret', secret);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/v1/locations/nearby should return users within specified radius', async () => {
    const res = await request(app)
      .get('/api/v1/locations/nearby?latitude=22.5726&longitude=88.3639&radiusMeters=2000')
      .set('x-engine-secret', secret);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data[0].userId).toBe('loc_user_01');
  });

  it('POST /api/v1/locations/geofences should create a new circular geofence', async () => {
    const geofencePayload = {
      name: 'Main Campus Hub',
      code: 'CAMPUS_HUB_01',
      description: 'Central academic delivery hub',
      shape: 'circle',
      center: {
        latitude: 22.5726,
        longitude: 88.3639,
      },
      radiusMeters: 500,
      category: 'campus',
      isActive: true,
      alertOnEntry: true,
    };

    const res = await request(app)
      .post('/api/v1/locations/geofences')
      .set('x-engine-secret', secret)
      .send(geofencePayload);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.code).toBe('CAMPUS_HUB_01');
  });
});

