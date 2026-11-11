import { Router, Request, Response, NextFunction } from 'express';
import { requireInternalOrAdmin } from '../middlewares/auth.middleware';
import { validateQuery, validateBody } from '../middlewares/validate';
import {
  liveLocationsQuerySchema,
  locationHistoryQuerySchema,
  nearbyLocationQuerySchema,
  createGeofenceSchema,
} from '../schemas/location.schema';
import { locationStreamService } from '../services/location-stream.service';
import { geofenceService } from '../services/geofence.service';
import { sendSuccess } from '../utils/response.utils';

const router = Router();

router.use(requireInternalOrAdmin);

/**
 * @route   GET /api/v1/locations/live
 * @desc    Get real-time live positions of all active users & delivery partners
 */
router.get(
  '/live',
  validateQuery(liveLocationsQuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { maxAgeMinutes, role, limit } = req.query as any;
      const locations = locationStreamService.getLiveLocations({
        maxAgeMinutes,
        role,
        limit,
      });

      return sendSuccess(res, locations, 'Live locations retrieved successfully', 200, {
        count: locations.length,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/v1/locations/nearby
 * @desc    Geospatial proximity query: Find active users/partners within radius
 */
router.get(
  '/nearby',
  validateQuery(nearbyLocationQuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { latitude, longitude, radiusMeters, role, limit } = req.query as any;
      const result = await locationStreamService.getNearbyUsers({
        latitude,
        longitude,
        radiusMeters,
        role,
        limit,
      });

      return sendSuccess(res, result.results, 'Nearby entities retrieved', 200, {
        total: result.total,
        count: result.results.length,
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/v1/locations/stream
 * @desc    Poll sliding event buffer for location stream
 */
router.get('/stream', (req: Request, res: Response) => {
  const { limit, since, role } = req.query;
  const events = locationStreamService.getBufferedEventStream({
    limit: limit ? parseInt(limit as string, 10) : 100,
    since: since ? new Date(since as string) : undefined,
    role: role as string,
  });

  return sendSuccess(res, events, 'Location stream buffer retrieved', 200, {
    count: events.length,
  });
});

/**
 * @route   GET /api/v1/locations/users/:userId/history
 * @desc    Get breadcrumb trajectory history for a specific user
 */
router.get(
  '/users/:userId/history',
  validateQuery(locationHistoryQuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { since, limit } = req.query as any;
      const history = await locationStreamService.getUserLocationHistory(
        req.params.userId,
        { since, limit }
      );

      return sendSuccess(res, history, 'Location history retrieved successfully', 200, {
        count: history.length,
        meta: { userId: req.params.userId },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /api/v1/locations/geofences
 * @desc    Create a circular or polygon geofence zone
 */
router.post(
  '/geofences',
  validateBody(createGeofenceSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const zone = await geofenceService.createGeofence(req.body);
      return sendSuccess(res, zone, 'Geofence zone created successfully', 201);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/v1/locations/geofences
 * @desc    List all active geofence zones
 */
router.get('/geofences', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const zones = await geofenceService.getActiveZones();
    return sendSuccess(res, zones, 'Active geofence zones retrieved', 200, {
      count: zones.length,
    });
  } catch (error) {
    next(error);
  }
});

export default router;

