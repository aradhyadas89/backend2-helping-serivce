import request from 'supertest';
import { createApp } from '../src/app';
import { livePingService } from '../src/services/live-ping.service';
import { env } from '../src/config/env';

const app = createApp();

describe('Live Ping & Production Render Readiness', () => {
  afterAll(() => {
    livePingService.stopLivePingWorker();
  });

  describe('1. Fast Live Ping & Probes', () => {
    it('GET /live-ping should return 200 with comprehensive production telemetry', async () => {
      const res = await request(app).get('/live-ping');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.status).toBe('live');
      expect(res.body.ping).toBe('pong');
      expect(res.body.service).toBe('Helping Services Sub-Backend');
      expect(res.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
      expect(res.body.uptime).toBeDefined();
      expect(res.body.uptime.human).toBeDefined();

      // Render platform environment metadata
      expect(res.body.render).toBeDefined();
      expect(typeof res.body.render.isRender).toBe('boolean');

      // Live Ping Anti-Sleep stats
      expect(res.body.selfPing).toBeDefined();
      expect(res.body.selfPing.targetUrl).toBeDefined();
      expect(res.body.selfPing.successRate).toBeDefined();

      // Database health
      expect(res.body.databases).toBeDefined();
      expect(res.body.databases.allConnected).toBeDefined();

      // WebSockets and system metrics
      expect(typeof res.body.activeWebSockets).toBe('number');
      expect(res.body.system).toBeDefined();
      expect(res.body.system.memoryRssMb).toBeGreaterThan(0);
      expect(res.body.system.nodeVersion).toBeDefined();
    });

    it('GET /ping should return fast 200 pong response for load balancers', async () => {
      const res = await request(app).get('/ping');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.ping).toBe('pong');
      expect(res.body.status).toBe('live');
    });

    it('GET /api/v1/health/ping and GET /api/v1/health/live-ping should return 200', async () => {
      const pingRes = await request(app).get('/api/v1/health/ping');
      expect(pingRes.status).toBe(200);
      expect(pingRes.body.success).toBe(true);
      expect(pingRes.body.ping).toBe('pong');

      const livePingRes = await request(app).get('/api/v1/health/live-ping');
      expect(livePingRes.status).toBe(200);
      expect(livePingRes.body.success).toBe(true);
      expect(livePingRes.body.telemetry).toBeDefined();
    });

    it('POST /api/v1/health/live-ping/trigger should execute manual probe test', async () => {
      const res = await request(app).post('/api/v1/health/live-ping/trigger');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.selfPing).toBeDefined();
      expect(res.body.selfPing.url).toBeDefined();
      expect(typeof res.body.selfPing.latencyMs).toBe('number');
    });
  });

  describe('2. Rate Limiting Exemption for Live Ping & Health Probes', () => {
    it('should NOT rate-limit repeated requests to /live-ping or /ping', async () => {
      // Send rapid requests to verify skip logic in express-rate-limit
      const requests = Array.from({ length: 15 }, () => request(app).get('/live-ping'));
      const responses = await Promise.all(requests);

      responses.forEach((res) => {
        expect(res.status).toBe(200);
        expect(res.body.ping).toBe('pong');
      });
    });
  });

  describe('3. LivePingService Unit Capabilities', () => {
    it('formatUptime should format seconds into human-readable duration', () => {
      expect(livePingService.formatUptime(45)).toBe('45s');
      expect(livePingService.formatUptime(125)).toBe('2m 5s');
      expect(livePingService.formatUptime(3665)).toBe('1h 1m 5s');
      expect(livePingService.formatUptime(90061)).toBe('1d 1h 1m 1s');
    });

    it('getTargetUrl should fallback to localhost if RENDER_EXTERNAL_URL is not set', () => {
      const url = livePingService.getTargetUrl();
      expect(url).toContain('/live-ping');
    });

    it('getLiveTelemetry should return accurate worker stats', () => {
      const telemetry = livePingService.getLiveTelemetry();
      expect(telemetry.intervalMinutes).toBe(env.LIVE_PING_INTERVAL_MINUTES);
      expect(telemetry.stats).toBeDefined();
      expect(typeof telemetry.stats.totalPingsSent).toBe('number');
      expect(typeof telemetry.stats.successRate).toBe('string');
      expect(Array.isArray(telemetry.recentHistory)).toBe(true);
    });

    it('startLivePingWorker and stopLivePingWorker should manage lifecycle cleanly', () => {
      livePingService.startLivePingWorker();
      const telemetryRunning = livePingService.getLiveTelemetry();
      expect(telemetryRunning.workerRunning).toBe(true);

      livePingService.stopLivePingWorker();
      const telemetryStopped = livePingService.getLiveTelemetry();
      expect(telemetryStopped.workerRunning).toBe(false);
    });
  });
});
