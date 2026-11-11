import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { logger } from '../config/logger';
import { env } from '../config/env';

export class AppError extends Error {
  public statusCode: number;
  public details?: any;

  constructor(message: string, statusCode: number = 400, details?: any) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NotFoundException extends AppError {
  constructor(message: string = 'Resource not found') {
    super(message, 404);
  }
}

export class UnauthorizedException extends AppError {
  constructor(message: string = 'Unauthorized') {
    super(message, 401);
  }
}

export class ForbiddenException extends AppError {
  constructor(message: string = 'Forbidden') {
    super(message, 403);
  }
}

export class BadRequestException extends AppError {
  constructor(message: string = 'Bad request', details?: any) {
    super(message, 400, details);
  }
}

export class ConflictException extends AppError {
  constructor(message: string = 'Resource conflict') {
    super(message, 409);
  }
}

export class InternalServerErrorException extends AppError {
  constructor(message: string = 'Internal server error') {
    super(message, 500);
  }
}

export function errorHandler(
  err: any,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const reqId = req.reqId || 'unknown';

  // 1. Zod Validation Errors
  if (err instanceof ZodError) {
    const formattedErrors = err.errors.map((e) => ({
      field: e.path.join('.'),
      message: e.message,
    }));
    logger.warn(`[${reqId}] Validation Error on ${req.method} ${req.originalUrl}:`, formattedErrors);
    res.status(400).json({
      success: false,
      error: {
        code: 400,
        message: 'Validation failed',
        details: formattedErrors,
      },
    });
    return;
  }

  // 2. Custom Application Errors
  if (err instanceof AppError) {
    logger.warn(`[${reqId}] AppError [${err.statusCode}] on ${req.method} ${req.originalUrl}: ${err.message}`);
    res.status(err.statusCode).json({
      success: false,
      error: {
        code: err.statusCode,
        message: err.message,
        details: err.details,
      },
    });
    return;
  }

  // 3. Mongoose CastError (invalid ObjectId, etc.)
  if (err.name === 'CastError') {
    res.status(400).json({
      success: false,
      error: {
        code: 400,
        message: `Invalid identifier format for field '${err.path}'`,
      },
    });
    return;
  }

  // 4. Mongoose Duplicate Key Error (E11000)
  if (err.code === 11000) {
    const duplicateFields = Object.keys(err.keyPattern || {});
    res.status(409).json({
      success: false,
      error: {
        code: 409,
        message: `Resource already exists with conflicting unique field: ${duplicateFields.join(', ')}`,
      },
    });
    return;
  }

  // 5. JWT Errors
  if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
    res.status(401).json({
      success: false,
      error: {
        code: 401,
        message: err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token signature',
      },
    });
    return;
  }

  // 6. Generic Unhandled Server Errors
  logger.error(`[${reqId}] Unhandled Internal Server Error on ${req.method} ${req.originalUrl}:`, err);
  const isProd = env.ENVIRONMENT === 'production';
  res.status(500).json({
    success: false,
    error: {
      code: 500,
      message: isProd ? 'Internal server error' : err.message || 'Internal server error',
      details: !isProd ? err.stack : undefined,
    },
  });
}

