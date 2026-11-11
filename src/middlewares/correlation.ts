import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const reqId = (req.headers['x-request-id'] as string) || crypto.randomUUID();
  req.reqId = reqId;
  res.setHeader('X-Request-Id', reqId);
  next();
}

