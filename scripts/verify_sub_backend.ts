import {
  connectDB,
  closeDB,
  getOrdersDb,
  getFleetDb,
  getTelemetryDb,
  getDatabaseHealth,
  isMultiCluster,
} from '../src/config/database';
import { env } from '../src/config/env';
import { logger } from '../src/config/logger';

async function verify() {
  logger.info('========================================================');
  logger.info('--- Verifying Sub-Backend 2 Interconnected Databases ---');
  logger.info('    (Completely Independent from Main Backend DBs)      ');
  logger.info('========================================================');
  logger.info(`Port: ${env.PORT}`);
  logger.info(`Target Environment: ${env.ENVIRONMENT}`);
  logger.info(`Main Backend URL: ${env.MAIN_BACKEND_URL}`);
  logger.info(`Multi-Cluster Dedicated Mode: ${isMultiCluster}`);

  try {
    await connectDB();

    const health = getDatabaseHealth();
    logger.info('--- Sub-Backend 2 Interconnected Database Status ---');

    // 1. Orders & Billing Database
    const orders = getOrdersDb();
    const ordersCols = await orders.db?.listCollections().toArray();
    logger.info(
      `1. Orders & Billing DB [${health.databases.orders.name}]: State=${orders.readyState} (${health.databases.orders.status})`
    );
    logger.info(
      `   Collections (${ordersCols?.length || 0}):`,
      ordersCols?.map((c) => c.name) || []
    );

    // 2. Partner Fleet & Wallets Database
    const fleet = getFleetDb();
    const fleetCols = await fleet.db?.listCollections().toArray();
    logger.info(
      `2. Partner Fleet & Wallets DB [${health.databases.fleet.name}]: State=${fleet.readyState} (${health.databases.fleet.status})`
    );
    logger.info(
      `   Collections (${fleetCols?.length || 0}):`,
      fleetCols?.map((c) => c.name) || []
    );

    // 3. Real-Time Telemetry & Geofencing Database
    const telemetry = getTelemetryDb();
    const telemetryCols = await telemetry.db?.listCollections().toArray();
    logger.info(
      `3. Real-Time Telemetry & Geofencing DB [${health.databases.telemetry.name}]: State=${telemetry.readyState} (${health.databases.telemetry.status})`
    );
    logger.info(
      `   Collections (${telemetryCols?.length || 0}):`,
      telemetryCols?.map((c) => c.name) || []
    );

    await closeDB();
    logger.info('========================================================');
    logger.info('--- Sub-Backend 2 Databases Verified Successfully ---');
    logger.info('========================================================');
    process.exit(0);
  } catch (err) {
    logger.error('Verification failed:', err);
    process.exit(1);
  }
}

verify();
