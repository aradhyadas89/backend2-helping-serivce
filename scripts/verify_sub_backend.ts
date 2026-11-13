import {
  connectDB,
  closeDB,
  getCoreDb,
  getCatalogDb,
  getAnalyticsDb,
  getDatabaseHealth,
  isMultiCluster,
} from '../src/config/database';
import { env } from '../src/config/env';
import { logger } from '../src/config/logger';

async function verify() {
  logger.info('========================================================');
  logger.info('--- Verifying Sub-Backend 3 Interconnected Databases ---');
  logger.info('========================================================');
  logger.info(`Port: ${env.PORT}`);
  logger.info(`Target Environment: ${env.ENVIRONMENT}`);
  logger.info(`Main Backend URL: ${env.MAIN_BACKEND_URL}`);
  logger.info(`Multi-Cluster Dedicated Mode: ${isMultiCluster}`);

  try {
    await connectDB();

    const health = getDatabaseHealth();
    logger.info('--- Interconnected Database Status ---');

    // 1. Core Database
    const core = getCoreDb();
    const coreCols = await core.db?.listCollections().toArray();
    logger.info(
      `1. Core DB [${health.databases.core.name}]: State=${core.readyState} (${health.databases.core.status})`
    );
    logger.info(`   Collections (${coreCols?.length || 0}):`, coreCols?.map((c) => c.name) || []);

    // 2. Catalog Database
    const catalog = getCatalogDb();
    const catalogCols = await catalog.db?.listCollections().toArray();
    logger.info(
      `2. Catalog DB [${health.databases.catalog.name}]: State=${catalog.readyState} (${health.databases.catalog.status})`
    );
    logger.info(`   Collections (${catalogCols?.length || 0}):`, catalogCols?.map((c) => c.name) || []);

    // 3. Analytics Database
    const analytics = getAnalyticsDb();
    const analyticsCols = await analytics.db?.listCollections().toArray();
    logger.info(
      `3. Analytics DB [${health.databases.analytics.name}]: State=${analytics.readyState} (${health.databases.analytics.status})`
    );
    logger.info(
      `   Collections (${analyticsCols?.length || 0}):`,
      analyticsCols?.map((c) => c.name) || []
    );

    await closeDB();
    logger.info('========================================================');
    logger.info('--- 3 Interconnected Databases Verified Successfully ---');
    logger.info('========================================================');
    process.exit(0);
  } catch (err) {
    logger.error('Verification failed:', err);
    process.exit(1);
  }
}

verify();
