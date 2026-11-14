import { Request, Response, NextFunction } from 'express';
import { logger } from '../config/logger';

/**
 * Recursively strips MongoDB query operators ($gt, $ne, $where, $regex, etc.)
 * and dot-notation property traversals from request payloads to prevent NoSQL injection.
 */
export function deepSanitize(target: any): boolean {
  let injectionDetected = false;

  if (!target || typeof target !== 'object') {
    return false;
  }

  if (Array.isArray(target)) {
    for (let i = 0; i < target.length; i++) {
      if (typeof target[i] === 'object' && target[i] !== null) {
        if (deepSanitize(target[i])) {
          injectionDetected = true;
        }
      }
    }
    return injectionDetected;
  }

  for (const key of Object.keys(target)) {
    if (key.startsWith('$') || key.includes('.')) {
      injectionDetected = true;
      delete target[key];
    } else if (typeof target[key] === 'object' && target[key] !== null) {
      if (deepSanitize(target[key])) {
        injectionDetected = true;
      }
    }
  }

  return injectionDetected;
}

/**
 * Express middleware that inspects and purges malicious NoSQL operators
 * from body, query parameters, and route params.
 */
export function noSqlSanitizer(req: Request, _res: Response, next: NextFunction): void {
  const bodyInjected = req.body ? deepSanitize(req.body) : false;
  const queryInjected = req.query ? deepSanitize(req.query) : false;
  const paramsInjected = req.params ? deepSanitize(req.params) : false;

  if (bodyInjected || queryInjected || paramsInjected) {
    logger.warn(
      `[SECURITY ALERT] NoSQL injection operator detected and neutralized on ${req.method} ${req.originalUrl} from IP: ${req.ip || 'unknown'}`
    );
  }

  next();
}
