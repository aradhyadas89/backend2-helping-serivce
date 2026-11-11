import { Router, Request, Response, NextFunction } from 'express';
import { requireInternalOrAdmin } from '../middlewares/auth.middleware';
import { validateQuery } from '../middlewares/validate';
import {
  deviceAnalyticsQuerySchema,
  deviceStreamQuerySchema,
} from '../schemas/device.schema';
import { deviceStreamService } from '../services/device-stream.service';
import { sendSuccess } from '../utils/response.utils';

const router = Router();

router.use(requireInternalOrAdmin);

/**
 * @route   GET /api/v1/devices/analytics
 * @desc    Get aggregated device & OS metrics (iOS vs Android breakdown, models, security anomalies)
 */
router.get(
  '/analytics',
  validateQuery(deviceAnalyticsQuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { timeframe, role } = req.query as any;
      const analytics = await deviceStreamService.getDeviceAnalytics({
        timeframe,
        role,
      });

      return sendSuccess(res, analytics, 'Device analytics retrieved successfully');
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/v1/devices/stream
 * @desc    Poll buffered device event stream
 */
router.get(
  '/stream',
  validateQuery(deviceStreamQuerySchema),
  (req: Request, res: Response) => {
    const { limit, since, osName, role } = req.query as any;
    const events = deviceStreamService.getBufferedEventStream({
      limit,
      since,
      osName,
      role,
    });

    return sendSuccess(res, events, 'Device event stream buffer retrieved', 200, {
      count: events.length,
    });
  }
);

/**
 * @route   GET /api/v1/devices/users/:userId/history
 * @desc    Get device telemetry trail for a specific user
 */
router.get(
  '/users/:userId/history',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
      const history = await deviceStreamService.getUserDeviceHistory(
        req.params.userId,
        limit
      );

      return sendSuccess(res, history, 'User device history retrieved', 200, {
        count: history.length,
        meta: { userId: req.params.userId },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;

