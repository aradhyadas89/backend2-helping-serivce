import http from 'http';
import { createApp } from './app';
import { env } from './config/env';
import { logger } from './config/logger';
import { connectDB, closeDB, ensureIndexes } from './config/database';
import { getCacheClient } from './config/redis';
import { setupWebSocketServer } from './websocket/ws-server';
import { userAnalysisService } from './services/user-analysis.service';
import { orderService } from './services/order.service';
import { livePingService } from './services/live-ping.service';
import { livePingService } from './services/live-ping.service';

async function bootstrap() {
  try {
    logger.info('========================================================');
    logger.info(`Starting ${env.PROJECT_NAME} v${env.VERSION}...`);
    logger.info(`Role: Sub-Backend for Helper-FullStack-Backend`);
    logger.info(`Target Environment: ${env.ENVIRONMENT}`);
    logger.info('========================================================');

    // 1. Establish Database Connection Pool across all 3 Interconnected Databases
    await connectDB();
    await ensureIndexes();

    // 2. Initialize Cache Provider (Upstash / IORedis / In-Memory)
    getCacheClient();

    // 3. Build Express Application
    const app = createApp();

    // 4. Create HTTP Server
    const server = http.createServer(app);

    // 5. Initialize WebSocket Server for live map streaming and security alerts
    const wss = setupWebSocketServer(server);

    // 6. Start Background Intelligence Worker, Payment Sweeper & Live Ping Anti-Sleep Worker
    userAnalysisService.startAutoWorker();
    orderService.startPaymentTimeoutSweeper();
    livePingService.startLivePingWorker();

    // 7. Start Listening
    server.listen(env.PORT, env.HOST, () => {
      logger.info(`Sub-Backend is listening on http://${env.HOST}:${env.PORT}`);
      logger.info(`Health check probe: http://${env.HOST}:${env.PORT}${env.API_V1_STR}/health`);
      logger.info(`WebSocket endpoint: ws://${env.HOST}:${env.PORT}/ws`);
    });

    // 8. Graceful Shutdown Handlers
    const shutdown = async (signal: string) => {
      logger.info(`Received ${signal}. Initiating graceful shutdown...`);

      // Stop accepting new connections
      server.close(() => {
        logger.info('HTTP server closed');
      });

      // Terminate all connected WebSockets
      wss.close(() => {
        logger.info('WebSocket server closed');
      });

      // Stop background analysis timers, payment sweeper, and live ping worker
      userAnalysisService.stopAutoWorker();
      orderService.stopPaymentTimeoutSweeper();
      livePingService.stopLivePingWorker();

      // Close DB connection pools
      await closeDB();

      logger.info('Sub-Backend shutdown complete. Exiting.');
      process.exit(0);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled Promise Rejection at:', promise, 'reason:', reason);
    });

    process.on('uncaughtException', (error) => {
      logger.error('Uncaught Exception thrown:', error);
      process.exit(1);
    });
  } catch (error) {
    logger.error('Fatal error during Sub-Backend initialization:', error);
    process.exit(1);
  }
}

if (process.env.NODE_ENV !== 'test') {
  bootstrap();
}

