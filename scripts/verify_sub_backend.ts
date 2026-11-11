import { connectDB, closeDB, getAnalyticsDb } from '../src/config/database';
import { env } from '../src/config/env';
import { logger } from '../src/config/logger';

async function verify() {
  logger.info('--- Verifying Sub-Backend Configuration & Connectivity ---');
  logger.info(`Port: ${env.PORT}`);
  logger.info(`Target Environment: ${env.ENVIRONMENT}`);
  logger.info(`Main Backend URL: ${env.MAIN_BACKEND_URL}`);
  logger.info(`Admin Sub-Backend Secret: ${env.ADMIN_SUB_BACKEND_SECRET.slice(0, 10)}...`);

  try {
    await connectDB();
    const db = getAnalyticsDb();
    logger.info(`Database State: ${db.readyState === 1 ? 'Connected (Ready)' : 'State ' + db.readyState}`);
    logger.info(`Database Name: ${db.name}`);

    const collections = await db.db?.listCollections().toArray();
    logger.info(`Collections present in ${db.name}:`, collections?.map((c) => c.name) || []);

    await closeDB();
    logger.info('--- Verification Completed Successfully ---');
    process.exit(0);
  } catch (err) {
    logger.error('Verification failed:', err);
    process.exit(1);
  }
}

verify();

