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

// Check if dedicated URLs are configured for each of the 3 Sub-Backend 2 databases
export const isMultiCluster =
  !isTestEnv &&
  Boolean(
    (env.MONGODB_ORDERS_URL || env.MONGODB_URL) &&
    (env.MONGODB_FLEET_URL || env.MONGODB_CORE_URL) &&
    (env.MONGODB_TELEMETRY_URL || env.MONGODB_ANALYTICS_URL)
  );

const commonConnectionOptions: ConnectOptions = {
  autoIndex: true,
  maxPoolSize: env.MONGODB_MAX_POOL_SIZE,
  minPoolSize: env.MONGODB_MIN_POOL_SIZE,
  maxIdleTimeMS: 30000,
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
  family: 4,
};

let ordersConnection: Connection | null = null;
let fleetConnection: Connection | null = null;
let telemetryConnection: Connection | null = null;

if (isMultiCluster) {
  const ordersUri = env.MONGODB_ORDERS_URL || env.MONGODB_URL;
  const fleetUri = env.MONGODB_FLEET_URL || env.MONGODB_CORE_URL;
  const telemetryUri = env.MONGODB_TELEMETRY_URL || env.MONGODB_ANALYTICS_URL;

  if (ordersUri) {
    ordersConnection = mongoose.createConnection(ordersUri, {
      ...commonConnectionOptions,
      dbName: env.MONGODB_ORDERS_DB_NAME,
    });
  }

  if (fleetUri) {
    fleetConnection = mongoose.createConnection(fleetUri, {
      ...commonConnectionOptions,
      dbName: env.MONGODB_FLEET_DB_NAME,
    });
  }

  if (telemetryUri) {
    telemetryConnection = mongoose.createConnection(telemetryUri, {
      ...commonConnectionOptions,
      dbName: env.MONGODB_TELEMETRY_DB_NAME,
    });
  }
}

let cachedConnectionPromise: Promise<typeof mongoose> | null = null;

/**
 * Connect to all 3 Sub-Backend 2 interconnected databases (separate from Main DB)
 */
export async function connectDB(): Promise<void> {
  if (isMultiCluster && ordersConnection && fleetConnection && telemetryConnection) {
    if (
      ordersConnection.readyState === 1 &&
      fleetConnection.readyState === 1 &&
      telemetryConnection.readyState === 1
    ) {
      return;
    }
    logger.info('Connecting to 3 Dedicated Sub-Backend 2 MongoDB Atlas Clusters...');
    try {
      await Promise.all([
        ordersConnection.asPromise(),
        fleetConnection.asPromise(),
        telemetryConnection.asPromise(),
      ]);
      logger.info(
        `All 3 dedicated Sub-Backend 2 MongoDB databases connected successfully:
  - 1. Orders & Billing DB: [${ordersConnection.host || 'Atlas'}] -> ${env.MONGODB_ORDERS_DB_NAME}
  - 2. Partner Fleet & Wallets DB: [${fleetConnection.host || 'Atlas'}] -> ${env.MONGODB_FLEET_DB_NAME}
  - 3. Real-Time Telemetry & Geofencing DB: [${telemetryConnection.host || 'Atlas'}] -> ${env.MONGODB_TELEMETRY_DB_NAME}`
      );
      return;
    } catch (err: any) {
      logger.error(`Error connecting to Sub-Backend 2 multi-cluster MongoDB: ${err.message}`);
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

  const defaultUrl =
    env.MONGODB_ORDERS_URL ||
    env.MONGODB_URL ||
    'mongodb://localhost:27017/helping_sub2_orders';
  const isSrv = defaultUrl.startsWith('mongodb+srv://');
  let mongoUri = defaultUrl;

  if (!isSrv) {
    mongoUri = defaultUrl.endsWith('/')
      ? `${defaultUrl}${env.MONGODB_ORDERS_DB_NAME}`
      : defaultUrl.includes('?') || defaultUrl.split('/').length > 3
      ? defaultUrl
      : `${defaultUrl}/${env.MONGODB_ORDERS_DB_NAME}`;
  }

  logger.info(`Connecting to Sub-Backend 2 MongoDB Cluster (${isSrv ? 'Atlas SRV' : 'Direct'})...`);

  try {
    cachedConnectionPromise = mongoose.connect(mongoUri, {
      ...commonConnectionOptions,
      dbName: env.MONGODB_ORDERS_DB_NAME,
    });
    await cachedConnectionPromise;
    logger.info(
      `Sub-Backend 2 MongoDB connected successfully. Interconnected databases: [1: ${env.MONGODB_ORDERS_DB_NAME}, 2: ${env.MONGODB_FLEET_DB_NAME}, 3: ${env.MONGODB_TELEMETRY_DB_NAME}]`
    );
  } catch (error) {
    cachedConnectionPromise = null;
    logger.error(`MongoDB connection error: ${error}`);
    throw error;
  }
}

/**
 * 1. Orders & Billing Database Connection (Sub-Backend 2 Dedicated)
 * Manages Orders, Product Catalog & Pricing, User Order Profiles & Surcharges
 */
export function getOrdersDb(): Connection {
  if (ordersConnection) {
    return ordersConnection;
  }
  return mongoose.connection.useDb(env.MONGODB_ORDERS_DB_NAME, { useCache: true });
}

/**
 * 2. Partner Fleet & Wallets Database Connection (Sub-Backend 2 Dedicated)
 * Manages Partner Profiles, Live States, Ratings, Reputation, Vehicles, Wallets & Cash Holds
 */
export function getFleetDb(): Connection {
  if (fleetConnection) {
    return fleetConnection;
  }
  return mongoose.connection.useDb(env.MONGODB_FLEET_DB_NAME, { useCache: true });
}

/**
 * 3. Real-Time Telemetry & Geofencing Database Connection (Sub-Backend 2 Dedicated)
 * Manages GPS Streams, Breadcrumbs, Device Health, Geofences, Security Alerts, and Behavioral Profiles
 */
export function getTelemetryDb(): Connection {
  if (telemetryConnection) {
    return telemetryConnection;
  }
  return mongoose.connection.useDb(env.MONGODB_TELEMETRY_DB_NAME, { useCache: true });
}

// Semantic and backward-compatible aliases
export const getCoreDb = getFleetDb;
export const getCatalogDb = getOrdersDb;
export const getAnalyticsDb = getTelemetryDb;

/**
 * Synchronize indexes across all 3 interconnected databases
 */
export async function ensureIndexes(): Promise<void> {
  try {
    const dbs = [getOrdersDb(), getFleetDb(), getTelemetryDb()];
    for (const db of dbs) {
      if (db.readyState === 1) {
        const modelNames = db.modelNames();
        for (const name of modelNames) {
          await db.model(name).syncIndexes();
        }
      }
    }
    logger.info('MongoDB indexes synchronized across all 3 Sub-Backend 2 databases successfully.');
  } catch (err: any) {
    logger.warn(`Background index synchronization warning: ${err.message}`);
  }
}

/**
 * Cleanly close all database connections
 */
export async function closeDB(): Promise<void> {
  try {
    if (ordersConnection) {
      await ordersConnection.close();
      ordersConnection = null;
    }
    if (fleetConnection) {
      await fleetConnection.close();
      fleetConnection = null;
    }
    if (telemetryConnection) {
      await telemetryConnection.close();
      telemetryConnection = null;
    }
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    cachedConnectionPromise = null;
    logger.info('Closed all Sub-Backend 2 MongoDB database connections cleanly');
  } catch (error) {
    logger.error('Error closing database connections:', error);
  }
}

/**
 * Diagnostic status probe for all 3 interconnected databases
 */
export function getDatabaseHealth() {
  const orders = getOrdersDb();
  const fleet = getFleetDb();
  const telemetry = getTelemetryDb();

  return {
    isMultiCluster,
    allConnected:
      (orders.readyState === 1 || mongoose.connection.readyState === 1) &&
      (fleet.readyState === 1 || mongoose.connection.readyState === 1) &&
      (telemetry.readyState === 1 || mongoose.connection.readyState === 1),
    databases: {
      orders: {
        name: env.MONGODB_ORDERS_DB_NAME,
        host: orders.host || mongoose.connection.host || 'local',
        readyState: orders.readyState,
        status: orders.readyState === 1 ? 'connected' : 'disconnected',
      },
      fleet: {
        name: env.MONGODB_FLEET_DB_NAME,
        host: fleet.host || mongoose.connection.host || 'local',
        readyState: fleet.readyState,
        status: fleet.readyState === 1 ? 'connected' : 'disconnected',
      },
      telemetry: {
        name: env.MONGODB_TELEMETRY_DB_NAME,
        host: telemetry.host || mongoose.connection.host || 'local',
        readyState: telemetry.readyState,
        status: telemetry.readyState === 1 ? 'connected' : 'disconnected',
      },
    },
  };
}
