import { Response } from 'express';
import { APIResponse } from '../types';

export function sendSuccess<T>(
  res: Response,
  data: T,
  message: string = 'Success',
  statusCode: number = 200,
  extra: {
    count?: number;
    total?: number;
    meta?: Record<string, any>;
  } = {}
): Response {
  const responsePayload: APIResponse<T> = {
    success: true,
    message,
    data,
    ...extra,
  };
  return res.status(statusCode).json(responsePayload);
}

