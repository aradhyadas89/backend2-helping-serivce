import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { UnauthorizedException, ForbiddenException } from './errorHandler';
import { AuthUser, UserRole } from '../types';

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

  if (!providedSecret || !validSecrets.includes(providedSecret)) {
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
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next(new UnauthorizedException('No bearer token provided'));
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET) as any;
    req.user = {
      userId: decoded.userId || decoded.id || decoded.sub,
      email: decoded.email,
      role: decoded.role || 'user',
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
    (secretHeader === env.ADMIN_SUB_BACKEND_SECRET ||
      secretHeader === env.ANALYSIS_ENGINE_SECRET)
  ) {
    req.isInternalService = true;
    return next();
  }

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.split(' ')[1];
    if (
      token === env.ADMIN_SUB_BACKEND_SECRET ||
      token === env.ANALYSIS_ENGINE_SECRET
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

