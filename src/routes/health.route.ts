import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';
import { env } from '../config/env';
import { locationStreamService } from '../services/location-stream.service';
import { deviceStreamService } from '../services/device-stream.service';
import { wsDispatcher } from '../websocket/ws-dispatcher';

const router = Router();

/**
 * @route   GET /api/v1/health
 * @desc    Kubernetes readiness, liveness, and startup probe endpoint
 */
router.get('/', (_req: Request, res: Response) => {
  const dbState = mongoose.connection.readyState;
  const isDbConnected = dbState === 1;

  const status = isDbConnected ? 'healthy' : 'degraded';
  const statusCode = isDbConnected ? 200 : 503;

  const memoryUsage = process.memoryUsage();

  res.status(statusCode).json({
    status,
    service: 'Helping Services Sub-Backend',
    version: env.VERSION,
    environment: env.ENVIRONMENT,
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.round(process.uptime()),
    database: {
      status: isDbConnected ? 'connected' : 'disconnected',
      readyState: dbState,
    },
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

export default router;

