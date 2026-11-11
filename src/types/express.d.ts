import { AuthUser } from './index';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      reqId?: string;
      isInternalService?: boolean;
    }
  }
}

export {};

