import request from 'supertest';
import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { getSecurityAlertModel } from '../src/models/SecurityAlert';

const app = createApp();

describe('Internal Telemetry Stream Ingestion Webhooks', () => {
  const validSecret = env.ADMIN_SUB_BACKEND_SECRET;

  describe('POST /api/v1/internal/locations/stream', () => {
    it('should reject requests without secret credentials with 401', async () => {
      const res = await request(app)
        .post('/api/v1/internal/locations/stream')
        .send({
          userId: 'user_123',
          latitude: 22.5726,
          longitude: 88.3639,
        });

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('should reject requests with wrong secret with 401', async () => {
      const res = await request(app)
        .post('/api/v1/internal/locations/stream')
        .set('x-engine-secret', 'invalid-secret-value')
        .send({
          userId: 'user_123',
          latitude: 22.5726,
          longitude: 88.3639,
        });

      expect(res.status).toBe(401);
    });

    it('should ingest valid location event successfully with 200', async () => {
      const payload = {
        userId: 'user_stream_01',
        userName: 'Alex Rider',
        userEmail: 'alex@example.com',
        role: 'partner',
        latitude: 22.5726,
        longitude: 88.3639,
        speed: 12.5,
        heading: 90,
        batteryLevel: 85,
      };

      const res = await request(app)
        .post('/api/v1/internal/locations/stream')
        .set('x-engine-secret', validSecret)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.userId).toBe('user_stream_01');
    });

    it('should trigger speed violation alert when speed exceeds threshold', async () => {
      const payload = {
        userId: 'speed_demon_01',
        userName: 'Fast Partner',
        role: 'partner',
        latitude: 22.5726,
        longitude: 88.3639,
        speed: 35.0, // 35 m/s = 126 km/h (> 90 km/h)
      };

      const res = await request(app)
        .post('/api/v1/internal/locations/stream')
        .set('x-engine-secret', validSecret)
        .send(payload);

      expect(res.status).toBe(200);

      const SecurityAlert = getSecurityAlertModel();
      const alert = await SecurityAlert.findOne({
        userId: 'speed_demon_01',
        alertType: 'speed_violation',
      });
      expect(alert).toBeDefined();
      expect(alert?.severity).toBe('high');
    });
  });

  describe('POST /api/v1/internal/devices/stream', () => {
    it('should ingest normal device telemetry event successfully', async () => {
      const payload = {
        userId: 'user_dev_01',
        userName: 'Sam Smith',
        role: 'user',
        osName: 'android',
        osVersion: '14.0',
        deviceBrand: 'Google',
        deviceModel: 'Pixel 8',
        batteryLevel: 80,
      };

      const res = await request(app)
        .post('/api/v1/internal/devices/stream')
        .set('x-admin-sub-backend-secret', validSecret)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.osName).toBe('android');
    });

    it('should detect rooted/jailbroken hardware and create critical security alert', async () => {
      const payload = {
        userId: 'user_compromised_01',
        userName: 'Rooted Hacker',
        role: 'partner',
        osName: 'android',
        deviceBrand: 'Xiaomi',
        deviceModel: 'Redmi Note',
        isRootedOrJailbroken: true,
      };

      const res = await request(app)
        .post('/api/v1/internal/devices/stream')
        .set('x-engine-secret', validSecret)
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.data.alertsTriggered).toContain('rooted_or_jailbroken');

      const SecurityAlert = getSecurityAlertModel();
      const alert = await SecurityAlert.findOne({
        userId: 'user_compromised_01',
        alertType: 'rooted_or_jailbroken',
      });
      expect(alert).toBeDefined();
      expect(alert?.severity).toBe('critical');
    });
  });
});

