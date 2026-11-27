import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { env } from '../config/env';
import { getDatabaseHealth } from '../config/database';
import { locationStreamService } from '../services/location-stream.service';
import { deviceStreamService } from '../services/device-stream.service';
import { wsDispatcher } from '../websocket/ws-dispatcher';
import { livePingService } from '../services/live-ping.service';

const router = Router();

/**
 * @route   GET /api/v1/health
 * @desc    Kubernetes / Render readiness, liveness, and startup probe endpoint for 3 interconnected DBs
 */
router.get('/', (_req: Request, res: Response) => {
  const dbHealth = getDatabaseHealth();
  const defaultState = mongoose.connection.readyState;
  const isDbConnected = dbHealth.allConnected || defaultState === 1;

  const status = isDbConnected ? 'healthy' : 'degraded';
  const statusCode = isDbConnected ? 200 : 503;

  const memoryUsage = process.memoryUsage();
  const uptimeSeconds = Math.round(process.uptime());

  res.status(statusCode).json({
    status,
    service: env.PROJECT_NAME,
    version: env.VERSION,
    environment: env.ENVIRONMENT,
    timestamp: new Date().toISOString(),
    uptimeSeconds,
    uptimeHuman: livePingService.formatUptime(uptimeSeconds),
    interconnectedServices: {
      mainBackend: env.MAIN_BACKEND_URL,
      backend2: env.BACKEND2_URL,
      backend3: env.BACKEND3_URL,
      backend4: env.BACKEND4_URL,
    },
    render: {
      isRender: env.IS_RENDER,
      externalUrl: env.RENDER_EXTERNAL_URL || null,
      serviceId: env.RENDER_SERVICE_ID || null,
    },
    database: {
      status: isDbConnected ? 'connected' : 'disconnected',
      readyState: defaultState,
    },
    databases: dbHealth.databases,
    buffers: {
      locationsBuffered: locationStreamService.getBufferedEventStream({ limit: 500 }).length,
      devicesBuffered: deviceStreamService.getBufferedEventStream({ limit: 500 }).length,
    },
    websockets: {
      activeConnections: wsDispatcher.getActiveCount(),
    },
    system: {
      memoryRssMb: Math.round(memoryUsage.rss / (1024 * 1024)),
      memoryHeapUsedMb: Math.round(memoryUsage.heapUsed / (1024 * 1024)),
      nodeVersion: process.version,
    },
  });
});

/**
 * @route   GET /api/v1/health/ping
 * @desc    Ultra-fast live ping probe for keepalive monitoring and load balancer checks
 */
router.get('/ping', (_req: Request, res: Response) => {
  const dbHealth = getDatabaseHealth();
  const uptimeSeconds = Math.round(process.uptime());
  const telemetry = livePingService.getLiveTelemetry();

  res.status(200).json({
    success: true,
    status: 'live',
    ping: 'pong',
    service: env.PROJECT_NAME,
    version: env.VERSION,
    environment: env.ENVIRONMENT,
    timestamp: new Date().toISOString(),
    uptimeSeconds,
    uptimeHuman: livePingService.formatUptime(uptimeSeconds),
    activeWebSockets: wsDispatcher.getActiveCount(),
    databases: {
      allConnected: dbHealth.allConnected,
      orders: dbHealth.databases.orders,
      fleet: dbHealth.databases.fleet,
      telemetry: dbHealth.databases.telemetry,
    },
    interconnectedServices: {
      mainBackend: env.MAIN_BACKEND_URL,
      backend2: env.BACKEND2_URL,
      backend3: env.BACKEND3_URL,
      backend4: env.BACKEND4_URL,
    },
    selfPing: {
      workerRunning: telemetry.workerRunning,
      targetUrl: telemetry.targetUrl,
      lastPingAt: telemetry.stats.lastPingAt,
      lastLatencyMs: telemetry.stats.lastPingLatencyMs,
      successRate: telemetry.stats.successRate,
      status: telemetry.stats.lastPingStatus,
    },
    render: telemetry.renderEnvironment,
  });
});

/**
 * @route   GET /api/v1/health/live-ping
 * @desc    Comprehensive live ping telemetry diagnostics and historical latency report
 */
router.get('/live-ping', (_req: Request, res: Response) => {
  const dbHealth = getDatabaseHealth();
  const uptimeSeconds = Math.round(process.uptime());
  const telemetry = livePingService.getLiveTelemetry();
  const memoryUsage = process.memoryUsage();

  res.status(200).json({
    success: true,
    status: 'live',
    ping: 'pong',
    service: env.PROJECT_NAME,
    version: env.VERSION,
    environment: env.ENVIRONMENT,
    timestamp: new Date().toISOString(),
    uptimeSeconds,
    uptimeHuman: livePingService.formatUptime(uptimeSeconds),
    activeWebSockets: wsDispatcher.getActiveCount(),
    databases: dbHealth.databases,
    telemetry,
    system: {
      memoryRssMb: Math.round(memoryUsage.rss / (1024 * 1024)),
      memoryHeapUsedMb: Math.round(memoryUsage.heapUsed / (1024 * 1024)),
      memoryHeapTotalMb: Math.round(memoryUsage.heapTotal / (1024 * 1024)),
      nodeVersion: process.version,
    },
  });
});

/**
 * @route   POST /api/v1/health/live-ping/trigger
 * @desc    Manually trigger an on-demand self-ping and optional external target checks
 */
router.post('/live-ping/trigger', async (_req: Request, res: Response) => {
  const selfPingResult = await livePingService.pingSelf();
  const externalResults = await livePingService.pingExternalTargets();

  res.status(200).json({
    success: true,
    message: 'Live ping probe executed successfully',
    selfPing: selfPingResult,
    externalTargets: externalResults,
    activeWebSockets: wsDispatcher.getActiveCount(),
    timestamp: new Date().toISOString(),
  });
});

export default router;
