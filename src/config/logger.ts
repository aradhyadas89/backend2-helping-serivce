import { env } from './env';

const SENSITIVE_KEYS = ['password', 'passwordHash', 'token', 'secret', 'otp', 'apiKey', 'authorization'];

function redactSensitiveData(data: any): any {
  if (!data || typeof data !== 'object') {
    return data;
  }
  if (Array.isArray(data)) {
    return data.map(redactSensitiveData);
  }
  const copy: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    if (SENSITIVE_KEYS.some((s) => key.toLowerCase().includes(s.toLowerCase()))) {
      copy[key] = '***REDACTED***';
    } else if (typeof value === 'object' && value !== null) {
      copy[key] = redactSensitiveData(value);
    } else {
      copy[key] = value;
    }
  }
  return copy;
}

export const logger = {
  info: (msg: string, ...args: any[]) => {
    const safeArgs = args.map(redactSensitiveData);
    if (!env.DEBUG && env.ENVIRONMENT === 'production') {
      console.log(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'INFO',
          service: 'sub-backend',
          message: msg,
          extra: safeArgs.length ? safeArgs : undefined,
        })
      );
    } else {
      console.log(`[INFO] [SUB-BACKEND] ${new Date().toISOString()} - ${msg}`, ...safeArgs);
    }
  },
  error: (msg: string, ...args: any[]) => {
    const safeArgs = args.map(redactSensitiveData);
    if (!env.DEBUG && env.ENVIRONMENT === 'production') {
      console.error(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'ERROR',
          service: 'sub-backend',
          message: msg,
          extra: safeArgs.length ? safeArgs : undefined,
        })
      );
    } else {
      console.error(`[ERROR] [SUB-BACKEND] ${new Date().toISOString()} - ${msg}`, ...safeArgs);
    }
  },
  warn: (msg: string, ...args: any[]) => {
    const safeArgs = args.map(redactSensitiveData);
    if (!env.DEBUG && env.ENVIRONMENT === 'production') {
      console.warn(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'WARN',
          service: 'sub-backend',
          message: msg,
          extra: safeArgs.length ? safeArgs : undefined,
        })
      );
    } else {
      console.warn(`[WARN] [SUB-BACKEND] ${new Date().toISOString()} - ${msg}`, ...safeArgs);
    }
  },
  debug: (msg: string, ...args: any[]) => {
    if (env.DEBUG) {
      const safeArgs = args.map(redactSensitiveData);
      console.debug(`[DEBUG] [SUB-BACKEND] ${new Date().toISOString()} - ${msg}`, ...safeArgs);
    }
  },
};

