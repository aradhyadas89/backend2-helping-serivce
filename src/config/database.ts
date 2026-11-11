import dns from 'dns';
import mongoose, { Connection, ConnectOptions } from 'mongoose';
import { env } from './env';
import { logger } from './logger';

// Fix for Node.js SRV DNS lookup issues on Windows / local ISP networks
try {
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch {
  // Ignore in restricted environments
}

let analyticsConnection: Connection | null = null;
let coreConnection: Connection | null = null;

const isTestEnv = process.env.NODE_ENV === 'test';

const mongooseOptions: ConnectOptions = {
  maxPoolSize: env.MONGODB_MAX_POOL_SIZE,
  minPoolSize: env.MONGODB_MIN_POOL_SIZE,
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 45000,
  family: 4,
  autoIndex: true,
};

export async function connectDB(): Promise<void> {
  // If running in test mode, memory server connects directly via mongoose.connect
  if (isTestEnv) {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(env.MONGODB_URL, mongooseOptions);
    }
    analyticsConnection = mongoose.connection;
    coreConnection = mongoose.connection;
    logger.info('Connected to in-memory test database');
    return;
  }

  try {
    const analyticsUri = env.MONGODB_ANALYTICS_URL || env.MONGODB_URL;
    logger.info(`Connecting to MongoDB Analytics Cluster at ${analyticsUri.replace(/\/\/([^:]+):([^@]+)@/, '//$1:***@')}...`);
    
    analyticsConnection = mongoose.createConnection(analyticsUri, mongooseOptions);

    await new Promise<void>((resolve, reject) => {
      analyticsConnection?.once('open', () => {
        logger.info('Connected to MongoDB Analytics Database');
        resolve();
      });
      analyticsConnection?.once('error', (err) => {
        logger.error('Failed to connect to MongoDB Analytics Database:', err);
        reject(err);
      });
    });

    // Optionally connect to Core DB if configured
    if (env.MONGODB_CORE_URL) {
      try {
        coreConnection = mongoose.createConnection(env.MONGODB_CORE_URL, mongooseOptions);
        await new Promise<void>((resolve, reject) => {
          coreConnection?.once('open', () => {
            logger.info('Connected to MongoDB Core Database');
            resolve();
          });
          coreConnection?.once('error', (err) => {
            logger.warn('Core DB connection warning (optional):', err);
            resolve(); // Don't crash if secondary core is not reachable
          });
        });
      } catch (err) {
        logger.warn('Could not establish optional secondary connection to Core DB:', err);
      }
    }
  } catch (error) {
    logger.error('Database connection error:', error);
    throw error;
  }
}

export function getAnalyticsDb(): Connection {
  if (analyticsConnection && analyticsConnection.readyState === 1) {
    return analyticsConnection;
  }
  // Fallback to default mongoose connection
  return mongoose.connection;
}

export function getCoreDb(): Connection {
  if (coreConnection && coreConnection.readyState === 1) {
    return coreConnection;
  }
  return getAnalyticsDb();
}

export async function closeDB(): Promise<void> {
  try {
    if (analyticsConnection) {
      await analyticsConnection.close();
      analyticsConnection = null;
    }
    if (coreConnection) {
      await coreConnection.close();
      coreConnection = null;
    }
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    logger.info('Closed all MongoDB database connections cleanly');
  } catch (error) {
    logger.error('Error closing database connections:', error);
  }
}

