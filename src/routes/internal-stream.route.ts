import { Router, Request, Response, NextFunction } from 'express';
import { verifyInternalSecret } from '../middlewares/auth.middleware';
import { validateBody } from '../middlewares/validate';
import { locationStreamEventSchema } from '../schemas/location.schema';
import { deviceStreamEventSchema } from '../schemas/device.schema';
import { locationStreamService } from '../services/location-stream.service';
import { deviceStreamService } from '../services/device-stream.service';

const router = Router();

// Strictly enforce internal secret verification for all stream webhooks
router.use(verifyInternalSecret);

/**
 * @route   POST /api/v1/internal/locations/stream
 * @desc    Receive real-time location stream telemetry dispatched from Main Backend
 */
router.post(
  '/locations/stream',
  validateBody(locationStreamEventSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await locationStreamService.ingestLocationEvent(req.body);
      res.status(200).json({
        success: true,
        message: 'Location telemetry event ingested and processed successfully.',
        data: {
          userId: req.body.userId,
          persisted: result.persisted,
          insideZones: result.insideZones,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /api/v1/internal/devices/stream
 * @desc    Receive real-time user OS & hardware telemetry dispatched from Main Backend
 */
router.post(
  '/devices/stream',
  validateBody(deviceStreamEventSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await deviceStreamService.ingestDeviceEvent(req.body);
      res.status(200).json({
        success: true,
        message: 'Device telemetry event ingested and analyzed successfully.',
        data: {
          userId: req.body.userId,
          osName: req.body.osName,
          persisted: result.persisted,
          alertsTriggered: result.alertsTriggered,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;

