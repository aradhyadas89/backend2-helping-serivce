import dotenv from 'dotenv';
import path from 'path';

// Load .env file
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

function parseCorsOrigins(raw: string | undefined): string[] {
  if (!raw) return ['http://localhost:3000', 'http://localhost:5173', 'http://localhost:8000'];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // If not JSON, handle as comma-separated list
    return raw.split(',').map((origin) => origin.trim()).filter(Boolean);
  }
  return ['http://localhost:3000', 'http://localhost:5173', 'http://localhost:8000'];
}

export const env = {
  PROJECT_NAME: process.env.PROJECT_NAME || 'Helping Services Sub-Backend',
  VERSION: process.env.VERSION || '1.0.0',
  API_V1_STR: process.env.API_V1_STR || '/api/v1',
  ENVIRONMENT: process.env.ENVIRONMENT || process.env.NODE_ENV || 'development',
  DEBUG: process.env.DEBUG === 'true' || process.env.NODE_ENV === 'development',

  HOST: process.env.HOST || '0.0.0.0',
  PORT: parseInt(process.env.PORT || '8001', 10),
  CORS_ORIGINS: parseCorsOrigins(process.env.BACKEND_CORS_ORIGINS),

  // Security Credentials
  ADMIN_SUB_BACKEND_SECRET: process.env.ADMIN_SUB_BACKEND_SECRET || 'helping-services-admin-sub-backend-secret-2026',
  ANALYSIS_ENGINE_SECRET: process.env.ANALYSIS_ENGINE_SECRET || 'helping-services-analysis-engine-secret-2026',
  JWT_SECRET: process.env.JWT_SECRET || 'helping-services-jwt-super-secret-key-2026',

  // Main Backend Interconnect
  MAIN_BACKEND_URL: process.env.MAIN_BACKEND_URL || 'http://localhost:8000',

  // Database URLs (3 Interconnected MongoDB Databases)
  MONGODB_URL: process.env.MONGODB_URL || 'mongodb://localhost:27017/helping_services_analytics',
  MONGODB_DB_NAME: process.env.MONGODB_DB_NAME || 'helping_services_analytics',
  
  // 1. Core / Identity DB (Users, Roles, Partner Profiles, Wallets, User Order Profiles)
  MONGODB_CORE_URL: process.env.MONGODB_CORE_URL || '',
  MONGODB_CORE_DB_NAME: process.env.MONGODB_CORE_DB_NAME || 'helping_services_core',

  // 2. Product Catalog DB (Admin Uploads, Products, Pricing in ₹, Categories, Stock)
  MONGODB_CATALOG_URL: process.env.MONGODB_CATALOG_URL || '',
  MONGODB_CATALOG_DB_NAME: process.env.MONGODB_CATALOG_DB_NAME || 'helping_services_catalog',

  // 3. User Intelligence & Analytics DB (Live Locations, Orders, Lifecycle, Devices, Alerts)
  MONGODB_ANALYTICS_URL: process.env.MONGODB_ANALYTICS_URL || process.env.MONGODB_URL || '',
  MONGODB_ANALYTICS_DB_NAME: process.env.MONGODB_ANALYTICS_DB_NAME || 'helping_services_analytics',

  MONGODB_MAX_POOL_SIZE: parseInt(process.env.MONGODB_MAX_POOL_SIZE || '50', 10),
  MONGODB_MIN_POOL_SIZE: parseInt(process.env.MONGODB_MIN_POOL_SIZE || '10', 10),

  // Redis / Distributed Cache
  REDIS_URL: process.env.REDIS_URL || '',
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL || '',
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN || '',

  // Real-Time & Analytics Rules
  MAX_STREAM_BUFFER_SIZE: parseInt(process.env.MAX_STREAM_BUFFER_SIZE || '2000', 10),
  LIVE_LOCATION_EXPIRY_MINUTES: parseInt(process.env.LIVE_LOCATION_EXPIRY_MINUTES || '30', 10),
  SPEED_ALERT_THRESHOLD_KMPH: parseFloat(process.env.SPEED_ALERT_THRESHOLD_KMPH || '90'),
  LOW_BATTERY_ALERT_THRESHOLD: parseInt(process.env.LOW_BATTERY_ALERT_THRESHOLD || '15', 10),
  AUTO_ANALYSIS_WORKER_INTERVAL_MS: parseInt(process.env.AUTO_ANALYSIS_WORKER_INTERVAL_MS || '300000', 10),
};

