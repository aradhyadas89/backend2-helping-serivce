import { Router, Request, Response, NextFunction } from 'express';
import { requireInternalOrAdmin } from '../middlewares/auth.middleware';
import { validateQuery, validateBody } from '../middlewares/validate';
import {
  listAlertsQuerySchema,
  updateAlertStatusSchema,
} from '../schemas/alert.schema';
import { alertService } from '../services/alert.service';
import { sendSuccess } from '../utils/response.utils';
import { NotFoundException } from '../middlewares/errorHandler';

const router = Router();

router.use(requireInternalOrAdmin);

/**
 * @route   GET /api/v1/alerts
 * @desc    List security & fleet operational alerts
 */
router.get(
  '/',
  validateQuery(listAlertsQuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { status, severity, alertType, role, limit, page } = req.query as any;
      const result = await alertService.listAlerts({
        status,
        severity,
        alertType,
        role,
        limit,
        page,
      });

      return sendSuccess(res, result.alerts, 'Alerts retrieved successfully', 200, {
        total: result.total,
        count: result.alerts.length,
        meta: { page: result.page, totalPages: result.totalPages },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/v1/alerts/stats
 * @desc    Get summary statistics of active alerts
 */
router.get('/stats', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const stats = await alertService.getAlertStats();
    return sendSuccess(res, stats, 'Alert statistics retrieved successfully');
  } catch (error) {
    next(error);
  }
});

/**
 * @route   PATCH /api/v1/alerts/:alertId/status
 * @desc    Acknowledge, resolve, or dismiss an alert
 */
router.patch(
  '/:alertId/status',
  validateBody(updateAlertStatusSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { status, note } = req.body;
      const updatedBy = req.user?.email || req.user?.userId || 'system_operator';

      const updated = await alertService.updateAlertStatus(
        req.params.alertId,
        status,
        updatedBy,
        note
      );

      if (!updated) {
        throw new NotFoundException(`Alert ${req.params.alertId} not found`);
      }

      return sendSuccess(res, updated, `Alert marked as ${status}`);
    } catch (error) {
      next(error);
    }
  }
);

export default router;

