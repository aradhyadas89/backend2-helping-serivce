import express, { Application, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { env } from './config/env';
import { correlationMiddleware } from './middlewares/correlation';
import { errorHandler, NotFoundException } from './middlewares/errorHandler';
import { getDatabaseHealth } from './config/database';
import { wsDispatcher } from './websocket/ws-dispatcher';
import apiRouter from './routes';

export function createApp(): Application {
  const app: Application = express();

  // Trust proxy in containerized / reverse proxy environments
  app.set('trust proxy', 1);

  // Correlation ID tracking
  app.use(correlationMiddleware);

  // Security Headers
  app.use(
    helmet({
      contentSecurityPolicy: false, // Allows flexible dashboard integrations
      crossOriginEmbedderPolicy: false,
    })
  );

  // CORS Configuration
  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow server-to-server or requests without origin (like curl, mobile apps)
        if (!origin) return callback(null, true);
        if (
          env.CORS_ORIGINS.includes('*') ||
          env.CORS_ORIGINS.includes(origin) ||
          env.ENVIRONMENT === 'development'
        ) {
          return callback(null, true);
        }
        return callback(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Request-Id',
        'x-engine-secret',
        'x-admin-sub-backend-secret',
        'x-device-brand',
        'x-device-model',
        'x-os-version',
      ],
    })
  );

  // Body compression
  app.use(compression());

  // JSON Body Parser with 10mb limit for telemetry batch payloads
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  // HTTP Request Logging
  if (env.ENVIRONMENT !== 'test') {
    app.use(
      morgan(
        ':remote-addr - :remote-user [:date[iso]] ":method :url HTTP/:http-version" :status :res[content-length] - :response-time ms'
      )
    );
  }

  // Rate Limiting (1000 requests per 15 mins per IP, skipped for internal calls)
  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req: Request) => {
      const secret =
        (req.headers['x-engine-secret'] as string) ||
        (req.headers['x-admin-sub-backend-secret'] as string);
      return secret === env.ADMIN_SUB_BACKEND_SECRET || secret === env.ANALYSIS_ENGINE_SECRET;
    },
    message: {
      success: false,
      error: {
        code: 429,
        message: 'Too many requests, please try again later.',
      },
    },
  });
  app.use('/api/', limiter);

  // Mount API router
  app.use(env.API_V1_STR, apiRouter);

  // Root Welcome Endpoint
  app.get('/', (_req: Request, res: Response) => {
    res.status(200).json({
      service: env.PROJECT_NAME,
      version: env.VERSION,
      role: 'Sub-Backend for Helper-FullStack-Backend',
      status: 'operational',
      documentation: `${env.API_V1_STR}/health`,
    });
  });

  // Fast Live Ping & Heartbeat Probes
  app.get(['/ping', '/live-ping', `${env.API_V1_STR}/ping`], (_req: Request, res: Response) => {
    const dbHealth = getDatabaseHealth();
    res.status(200).json({
      success: true,
      status: 'live',
      ping: 'pong',
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      activeWebSockets: wsDispatcher.getActiveCount(),
      databases: {
        allConnected: dbHealth.allConnected,
        orders: dbHealth.databases.orders,
        fleet: dbHealth.databases.fleet,
        telemetry: dbHealth.databases.telemetry,
      },
    });
  });

  // 404 Catch-All Handler
  app.use((req: Request, _res: Response, next: NextFunction) => {
    next(new NotFoundException(`Route ${req.method} ${req.originalUrl} not found`));
  });

  // Centralized Error Handler
  app.use(errorHandler);

  return app;
}

