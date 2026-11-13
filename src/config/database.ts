import dns from 'dns';
import mongoose, { Connection, ConnectOptions } from 'mongoose';
import { env } from './env';
import { logger } from './logger';

// Fix for Node.js SRV DNS lookup issues on Windows / local ISP networks
if (process.platform === 'win32' && !process.env.VERCEL) {
  try {
    dns.setServers(['8.8.8.8', '1.1.1.1', '8.8.4.4']);
  } catch {
    // Ignore if network permissions restrict custom DNS servers
  }
}

const isTestEnv = process.env.NODE_ENV === 'test';

// Check if dedicated URLs are configured for each of the 3 databases
export const isMultiCluster =
  !isTestEnv &&
  Boolean(env.MONGODB_CORE_URL && env.MONGODB_CATALOG_URL && env.MONGODB_ANALYTICS_URL);

const commonConnectionOptions: ConnectOptions = {
  autoIndex: true,
  maxPoolSize: env.MONGODB_MAX_POOL_SIZE,
  minPoolSize: env.MONGODB_MIN_POOL_SIZE,
  maxIdleTimeMS: 30000,
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
  family: 4,
};

let coreConnection: Connection | null = null;
let catalogConnection: Connection | null = null;
let analyticsConnection: Connection | null = null;

if (isMultiCluster) {
  coreConnection = mongoose.createConnection(env.MONGODB_CORE_URL, {
    ...commonConnectionOptions,
    dbName: env.MONGODB_CORE_DB_NAME,
  });
  catalogConnection = mongoose.createConnection(env.MONGODB_CATALOG_URL, {
    ...commonConnectionOptions,
    dbName: env.MONGODB_CATALOG_DB_NAME,
  });
  analyticsConnection = mongoose.createConnection(env.MONGODB_ANALYTICS_URL, {
    ...commonConnectionOptions,
    dbName: env.MONGODB_ANALYTICS_DB_NAME,
  });
}

let cachedConnectionPromise: Promise<typeof mongoose> | null = null;

/**
 * Connect to all 3 interconnected databases or single-cluster/in-memory fallback
 */
export async function connectDB(): Promise<void> {
  if (isMultiCluster && coreConnection && catalogConnection && analyticsConnection) {
    logger.info('Connecting to 3 Dedicated MongoDB Atlas Clusters...');
    try {
      await Promise.all([
        coreConnection.asPromise(),
        catalogConnection.asPromise(),
        analyticsConnection.asPromise(),
      ]);
      logger.info(
        `All 3 dedicated MongoDB Atlas clusters connected successfully:
  - 1. Core DB: [${coreConnection.host || 'Atlas'}] -> ${env.MONGODB_CORE_DB_NAME}
  - 2. Catalog DB: [${catalogConnection.host || 'Atlas'}] -> ${env.MONGODB_CATALOG_DB_NAME}
  - 3. Analytics DB: [${analyticsConnection.host || 'Atlas'}] -> ${env.MONGODB_ANALYTICS_DB_NAME}`
      );
      return;
    } catch (err: any) {
      logger.error(`Error connecting to multi-cluster MongoDB: ${err.message}`);
      throw err;
    }
  }

  // Single-cluster or In-Memory test fallback
  if (mongoose.connection.readyState === 1) {
    return;
  }

  if (mongoose.connection.readyState === 2 && cachedConnectionPromise) {
    await cachedConnectionPromise;
    return;
  }

  const defaultUrl = env.MONGODB_ANALYTICS_URL || env.MONGODB_URL || 'mongodb://localhost:27017/helping_services_analytics';
  const isSrv = defaultUrl.startsWith('mongodb+srv://');
  let mongoUri = defaultUrl;

  if (!isSrv) {
    mongoUri = defaultUrl.endsWith('/')
      ? `${defaultUrl}${env.MONGODB_ANALYTICS_DB_NAME}`
      : defaultUrl.includes('?') || defaultUrl.split('/').length > 3
      ? defaultUrl
      : `${defaultUrl}/${env.MONGODB_ANALYTICS_DB_NAME}`;
  }

  logger.info(`Connecting to MongoDB Cluster (${isSrv ? 'Atlas SRV' : 'Direct'})...`);

  try {
    cachedConnectionPromise = mongoose.connect(mongoUri, {
      ...commonConnectionOptions,
      dbName: env.MONGODB_ANALYTICS_DB_NAME,
    });
    await cachedConnectionPromise;
    logger.info(
      `MongoDB connected successfully. Interconnected databases: [1: ${env.MONGODB_CORE_DB_NAME}, 2: ${env.MONGODB_CATALOG_DB_NAME}, 3: ${env.MONGODB_ANALYTICS_DB_NAME}]`
    );
  } catch (error) {
    cachedConnectionPromise = null;
    logger.error(`MongoDB connection error: ${error}`);
    throw error;
  }
}

/**
 * 1. Core / Identity Database Connection
 * Manages Partners, PartnerWallets, UserOrderProfiles, and User Auth/Roles
 */
export function getCoreDb(): Connection {
  if (coreConnection) {
    return coreConnection;
  }
  return mongoose.connection.useDb(env.MONGODB_CORE_DB_NAME, { useCache: true });
}

/**
 * 2. Product Catalog Database Connection
 * Manages Products, Pricing in ₹, Categories, Stock, and Catalog metadata
 */
export function getCatalogDb(): Connection {
  if (catalogConnection) {
    return catalogConnection;
  }
  return mongoose.connection.useDb(env.MONGODB_CATALOG_DB_NAME, { useCache: true });
}

/**
 * 3. User Intelligence, Operations & Analytics Database Connection
 * Manages Orders, Live Locations, Device Telemetry, Geofences, Alerts, Events, and Behavioral Profiles
 */
export function getAnalyticsDb(): Connection {
  if (analyticsConnection) {
    return analyticsConnection;
  }
  return mongoose.connection.useDb(env.MONGODB_ANALYTICS_DB_NAME, { useCache: true });
}

/**
 * Synchronize indexes across all 3 interconnected databases
 */
export async function ensureIndexes(): Promise<void> {
  try {
    const dbs = [getCoreDb(), getCatalogDb(), getAnalyticsDb()];
    for (const db of dbs) {
      if (db.readyState === 1) {
        const modelNames = db.modelNames();
        for (const name of modelNames) {
          await db.model(name).syncIndexes();
        }
      }
    }
    logger.info('MongoDB indexes synchronized across all 3 databases successfully.');
  } catch (err: any) {
    logger.warn(`Background index synchronization warning: ${err.message}`);
  }
}

/**
 * Cleanly close all database connections
 */
export async function closeDB(): Promise<void> {
  try {
    if (coreConnection) {
      await coreConnection.close();
      coreConnection = null;
    }
    if (catalogConnection) {
      await catalogConnection.close();
      catalogConnection = null;
    }
    if (analyticsConnection) {
      await analyticsConnection.close();
      analyticsConnection = null;
    }
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    cachedConnectionPromise = null;
    logger.info('Closed all MongoDB database connections cleanly');
  } catch (error) {
    logger.error('Error closing database connections:', error);
  }
}

/**
 * Diagnostic status probe for all 3 interconnected databases
 */
export function getDatabaseHealth() {
  const core = getCoreDb();
  const catalog = getCatalogDb();
  const analytics = getAnalyticsDb();

  return {
    isMultiCluster,
    allConnected:
      (core.readyState === 1 || mongoose.connection.readyState === 1) &&
      (catalog.readyState === 1 || mongoose.connection.readyState === 1) &&
      (analytics.readyState === 1 || mongoose.connection.readyState === 1),
    databases: {
      core: {
        name: env.MONGODB_CORE_DB_NAME,
        host: core.host || mongoose.connection.host || 'local',
        readyState: core.readyState,
        status: core.readyState === 1 ? 'connected' : 'disconnected',
      },
      catalog: {
        name: env.MONGODB_CATALOG_DB_NAME,
        host: catalog.host || mongoose.connection.host || 'local',
        readyState: catalog.readyState,
        status: catalog.readyState === 1 ? 'connected' : 'disconnected',
      },
      analytics: {
        name: env.MONGODB_ANALYTICS_DB_NAME,
        host: analytics.host || mongoose.connection.host || 'local',
        readyState: analytics.readyState,
        status: analytics.readyState === 1 ? 'connected' : 'disconnected',
      },
    },
  };
}
