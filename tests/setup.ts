import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { env } from '../src/config/env';
import { getOrdersDb, getFleetDb, getTelemetryDb, closeDB } from '../src/config/database';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  mongoServer = await MongoMemoryServer.create();
  const uri = mongoServer.getUri();

  env.MONGODB_URL = uri;
  env.MONGODB_ORDERS_URL = uri;
  env.MONGODB_FLEET_URL = uri;
  env.MONGODB_TELEMETRY_URL = uri;
  env.MONGODB_ANALYTICS_URL = uri;
  env.MONGODB_CORE_URL = uri;
  env.MONGODB_CATALOG_URL = uri;

  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(uri);
  }
});

afterAll(async () => {
  await closeDB();
  if (mongoServer) {
    await mongoServer.stop();
  }
});

afterEach(async () => {
  // Clear collections across all 3 Sub-Backend 2 interconnected databases
  const dbs = [getOrdersDb(), getFleetDb(), getTelemetryDb(), mongoose.connection];
  for (const db of dbs) {
    if (db && db.readyState === 1) {
      const collections = db.collections;
      for (const key of Object.keys(collections)) {
        await collections[key].deleteMany({});
      }
    }
  }
});
