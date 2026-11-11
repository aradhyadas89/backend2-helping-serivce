import { env } from './env';

export const logger = {
  info: (msg: string, ...args: any[]) => {
    if (!env.DEBUG && env.ENVIRONMENT === 'production') {
      console.log(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'INFO',
          service: 'sub-backend',
          message: msg,
          extra: args.length ? args : undefined,
        })
      );
    } else {
      console.log(`[INFO] [SUB-BACKEND] ${new Date().toISOString()} - ${msg}`, ...args);
    }
  },
  error: (msg: string, ...args: any[]) => {
    if (!env.DEBUG && env.ENVIRONMENT === 'production') {
      console.error(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'ERROR',
          service: 'sub-backend',
          message: msg,
          extra: args.length ? args : undefined,
        })
      );
    } else {
      console.error(`[ERROR] [SUB-BACKEND] ${new Date().toISOString()} - ${msg}`, ...args);
    }
  },
  warn: (msg: string, ...args: any[]) => {
    if (!env.DEBUG && env.ENVIRONMENT === 'production') {
      console.warn(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'WARN',
          service: 'sub-backend',
          message: msg,
          extra: args.length ? args : undefined,
        })
      );
    } else {
      console.warn(`[WARN] [SUB-BACKEND] ${new Date().toISOString()} - ${msg}`, ...args);
    }
  },
  debug: (msg: string, ...args: any[]) => {
    if (env.DEBUG) {
      console.debug(`[DEBUG] [SUB-BACKEND] ${new Date().toISOString()} - ${msg}`, ...args);
    }
  },
};

