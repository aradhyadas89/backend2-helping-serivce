import { Redis as UpstashRedis } from '@upstash/redis';
import Redis from 'ioredis';
import { env } from './env';
import { logger } from './logger';

export interface CacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<'OK' | null>;
  del(key: string): Promise<number>;
  sadd(key: string, member: string): Promise<number>;
  sismember(key: string, member: string): Promise<number | boolean>;
}

class InMemoryCache implements CacheClient {
  private store = new Map<string, { value: string; expiresAt: number | null }>();
  private sets = new Map<string, Set<string>>();

  async get(key: string): Promise<string | null> {
    const item = this.store.get(key);
    if (!item) return null;
    if (item.expiresAt && Date.now() > item.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return item.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<'OK' | null> {
    const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : null;
    this.store.set(key, { value, expiresAt });
    return 'OK';
  }

  async del(key: string): Promise<number> {
    const deleted = this.store.delete(key) ? 1 : 0;
    this.sets.delete(key);
    return deleted;
  }

  async sadd(key: string, member: string): Promise<number> {
    if (!this.sets.has(key)) {
      this.sets.set(key, new Set());
    }
    const set = this.sets.get(key)!;
    const initialSize = set.size;
    set.add(member);
    return set.size - initialSize;
  }

  async sismember(key: string, member: string): Promise<boolean> {
    const set = this.sets.get(key);
    return set ? set.has(member) : false;
  }
}

let cacheClientInstance: CacheClient | null = null;

export function getCacheClient(): CacheClient {
  if (cacheClientInstance) {
    return cacheClientInstance;
  }

  // 1. Upstash Redis REST
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    try {
      const upstash = new UpstashRedis({
        url: env.UPSTASH_REDIS_REST_URL,
        token: env.UPSTASH_REDIS_REST_TOKEN,
      });

      cacheClientInstance = {
        async get(key: string) {
          const res = await upstash.get(key);
          return res !== null && res !== undefined ? String(res) : null;
        },
        async set(key: string, value: string, ttlSeconds?: number) {
          if (ttlSeconds) {
            await upstash.set(key, value, { ex: ttlSeconds });
          } else {
            await upstash.set(key, value);
          }
          return 'OK';
        },
        async del(key: string) {
          return await upstash.del(key);
        },
        async sadd(key: string, member: string) {
          return await upstash.sadd(key, member);
        },
        async sismember(key: string, member: string) {
          const res = await upstash.sismember(key, member);
          return Boolean(res);
        },
      };
      logger.info('Connected to Upstash Redis REST client');
      return cacheClientInstance;
    } catch (err) {
      logger.warn('Failed to initialize Upstash Redis, falling back:', err);
    }
  }

  // 2. Direct TCP Redis (IORedis)
  if (env.REDIS_URL) {
    try {
      const ioRedis = new Redis(env.REDIS_URL, {
        maxRetriesPerRequest: 2,
        lazyConnect: true,
      });

      cacheClientInstance = {
        async get(key: string) {
          return await ioRedis.get(key);
        },
        async set(key: string, value: string, ttlSeconds?: number) {
          if (ttlSeconds) {
            return (await ioRedis.set(key, value, 'EX', ttlSeconds)) as 'OK' | null;
          }
          return (await ioRedis.set(key, value)) as 'OK' | null;
        },
        async del(key: string) {
          return await ioRedis.del(key);
        },
        async sadd(key: string, member: string) {
          return await ioRedis.sadd(key, member);
        },
        async sismember(key: string, member: string) {
          return (await ioRedis.sismember(key, member)) === 1;
        },
      };
      logger.info('Connected to TCP Redis via ioredis');
      return cacheClientInstance;
    } catch (err) {
      logger.warn('Failed to initialize IORedis, falling back to in-memory store:', err);
    }
  }

  // 3. In-memory fallback
  logger.info('Using high-performance in-memory cache provider');
  cacheClientInstance = new InMemoryCache();
  return cacheClientInstance;
}

