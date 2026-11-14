import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { UnauthorizedException, ForbiddenException } from './errorHandler';
import { AuthUser, UserRole } from '../types';
import { getPartnerModel } from '../models/Partner';
import { getCacheClient } from '../config/redis';

/**
 * Constant-time comparison using pre-hashed SHA-256 buffers to eliminate timing attacks
 */
export function timingSafeSecretCheck(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const hashProvided = crypto.createHash('sha256').update(provided).digest();
  const hashExpected = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(hashProvided, hashExpected);
}

/**
 * Verifies shared secret credentials for internal service-to-service communication
 * (e.g., streaming webhooks from Helper-FullStack-Backend).
 */
export function verifyInternalSecret(req: Request, _res: Response, next: NextFunction): void {
  const secretHeader =
    (req.headers['x-engine-secret'] as string) ||
    (req.headers['x-admin-sub-backend-secret'] as string);

  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : undefined;

  const providedSecret = secretHeader || token;

  const validSecrets = [env.ADMIN_SUB_BACKEND_SECRET, env.ANALYSIS_ENGINE_SECRET];
  const isMatch = !!providedSecret && validSecrets.some((s) => timingSafeSecretCheck(providedSecret, s));

  if (!providedSecret || !isMatch) {
    return next(
      new UnauthorizedException('Unauthorized. Invalid Sub-Backend shared secret credentials.')
    );
  }

  req.isInternalService = true;
  next();
}

/**
 * Authenticates JWT bearer token for Admin Panel / Operator requests
 */
export async function authenticate(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(new UnauthorizedException('No bearer token provided'));
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as any;
    const userId = decoded.userId || decoded.id || decoded.sub;
    const role = decoded.role || 'user';

    // Zero-Trust Active Account Verification: Ensure suspended / blocked partners are halted
    if (role === 'partner' && userId) {
      try {
        const Partner = getPartnerModel();
        const partner = await Partner.findOne({ partnerId: userId }).select('isBlocked').lean();
        if (partner?.isBlocked) {
          return next(new UnauthorizedException('Account has been suspended. Access denied.'));
        }
      } catch {
        // Fallback gracefully if database lookup errors
      }
    }

    // Check Redis Token Revocation / Blacklist
    try {
      const cache = getCacheClient();
      const isRevoked = await cache.get(`token:revoked:${token}`);
      if (isRevoked) {
        return next(new UnauthorizedException('Authentication token has been revoked.'));
      }
    } catch {
      // In-memory or cache fallback
    }

    req.user = {
      userId,
      email: decoded.email,
      role,
      name: decoded.name,
    };
    next();
  } catch {
    return next(new UnauthorizedException('Invalid or expired token'));
  }
}

/**
 * Authorizes specific user roles (e.g. 'admin')
 */
export function authorizeRole(...roles: UserRole[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(new UnauthorizedException('Authentication required'));
    }

    if (!roles.includes(req.user.role)) {
      return next(new ForbiddenException(`Access forbidden for role: ${req.user.role}`));
    }

    next();
  };
}

/**
 * Flexible Authenticator: Accepts either valid internal secret OR valid admin JWT
 */
export function requireInternalOrAdmin(req: Request, res: Response, next: NextFunction): void {
  const secretHeader =
    (req.headers['x-engine-secret'] as string) ||
    (req.headers['x-admin-sub-backend-secret'] as string);

  if (
    secretHeader &&
    (timingSafeSecretCheck(secretHeader, env.ADMIN_SUB_BACKEND_SECRET) ||
      timingSafeSecretCheck(secretHeader, env.ANALYSIS_ENGINE_SECRET))
  ) {
    req.isInternalService = true;
    return next();
  }

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    if (
      timingSafeSecretCheck(token, env.ADMIN_SUB_BACKEND_SECRET) ||
      timingSafeSecretCheck(token, env.ANALYSIS_ENGINE_SECRET)
    ) {
      req.isInternalService = true;
      return next();
    }

    try {
      const decoded = jwt.verify(token, env.JWT_SECRET) as any;
      if (decoded.role === 'admin') {
        req.user = {
          userId: decoded.userId || decoded.id,
          email: decoded.email,
          role: decoded.role,
          name: decoded.name,
        };
        return next();
      }
    } catch {
      // Fall through to unauthorized
    }
  }

  return next(
    new UnauthorizedException(
      'Unauthorized. Requires either valid internal service secret or admin authorization.'
    )
  );
}

