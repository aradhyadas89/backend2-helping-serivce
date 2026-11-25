import type { Request, Response } from 'express';
import { app } from '../src/app';
import { connectDB } from '../src/config/database';

export default async function handler(req: Request, res: Response) {
  try {
    await connectDB();
  } catch (err: any) {
    console.error('[Serverless DB Error - Backend 2]:', err.message);
  }
  return app(req, res);
}
