import { getCacheClient } from '../src/config/redis';
import { env } from '../src/config/env';
import { logger } from '../src/config/logger';

async function testRedis() {
  logger.info('========================================================');
  logger.info('--- Verifying Upstash Redis Connectivity ---');
  logger.info('========================================================');
  logger.info(`REST URL: ${env.UPSTASH_REDIS_REST_URL}`);
  logger.info(`Token: ${env.UPSTASH_REDIS_REST_TOKEN.slice(0, 15)}...`);
  logger.info(`TCP URL: ${env.REDIS_URL.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@')}`);

  try {
    const cache = getCacheClient();

    const testKey = `test:sub2:ping:${Date.now()}`;
    const testVal = 'sub2_operational_hello_world';

    logger.info(`Setting test key: "${testKey}"...`);
    await cache.set(testKey, testVal, 60);

    const retrieved = await cache.get(testKey);
    logger.info(`Retrieved test key value: "${retrieved}"`);

    if (retrieved === testVal) {
      await cache.del(testKey);
      logger.info('✅ Upstash Redis verification SUCCESSFUL! SET/GET/DEL confirmed.');
      process.exit(0);
    } else {
      logger.error(`❌ Value mismatch: expected "${testVal}", got "${retrieved}"`);
      process.exit(1);
    }
  } catch (err: any) {
    logger.error('❌ Redis verification error:', err);
    process.exit(1);
  }
}

testRedis();
