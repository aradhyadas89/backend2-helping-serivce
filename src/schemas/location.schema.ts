import { z } from 'zod';

export const locationStreamEventSchema = z.object({
  id: z.string().optional(),
  userId: z.string().min(1, 'userId is required'),
  userName: z.string().optional().default(''),
  userEmail: z.string().optional().default(''),
  role: z.enum(['user', 'partner', 'admin']).default('user'),
  coordinates: z
    .object({
      type: z.literal('Point').default('Point'),
      coordinates: z.tuple([
        z.number().min(-180).max(180), // longitude
        z.number().min(-90).max(90),   // latitude
      ]),
    })
    .optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().min(0).optional(),
  altitude: z.number().optional(),
  speed: z.number().min(0).optional(),
  heading: z.number().min(0).max(360).optional(),
  batteryLevel: z.number().min(0).max(100).optional(),
  isMoving: z.boolean().optional(),
  activityType: z.string().optional(),
  isMocked: z.boolean().optional(),
  address: z.string().optional(),
  timestamp: z
    .union([z.string(), z.date()])
    .transform((val) => new Date(val))
    .default(() => new Date()),
});

export type LocationStreamEventInput = z.input<typeof locationStreamEventSchema>;
export type LocationStreamEventOutput = z.infer<typeof locationStreamEventSchema>;

export const liveLocationsQuerySchema = z.object({
  maxAgeMinutes: z
    .string()
    .optional()
    .transform((val) => (val ? Math.max(1, Math.min(1440, parseInt(val, 10))) : 30)),
  role: z.enum(['user', 'partner', 'admin']).optional(),
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? Math.max(1, Math.min(500, parseInt(val, 10))) : 100)),
});

export const locationHistoryQuerySchema = z.object({
  since: z
    .string()
    .optional()
    .transform((val) => (val ? new Date(val) : undefined)),
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? Math.max(1, Math.min(1000, parseInt(val, 10))) : 100)),
});

export const nearbyLocationQuerySchema = z.object({
  latitude: z.string().transform((val) => {
    const num = parseFloat(val);
    if (isNaN(num) || num < -90 || num > 90) throw new Error('Invalid latitude');
    return num;
  }),
  longitude: z.string().transform((val) => {
    const num = parseFloat(val);
    if (isNaN(num) || num < -180 || num > 180) throw new Error('Invalid longitude');
    return num;
  }),
  radiusMeters: z
    .string()
    .optional()
    .transform((val) => (val ? Math.max(10, Math.min(100000, parseFloat(val))) : 5000)),
  role: z.enum(['user', 'partner', 'admin']).optional(),
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? Math.max(1, Math.min(200, parseInt(val, 10))) : 50)),
});

export const createGeofenceSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  code: z.string().min(2, 'Code must be unique and at least 2 characters'),
  description: z.string().optional(),
  shape: z.enum(['circle', 'polygon']),
  center: z
    .object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
    })
    .optional(),
  radiusMeters: z.number().min(10).optional(),
  polygonCoordinates: z
    .array(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]))
    .min(3)
    .optional(),
  category: z.enum(['campus', 'service_hub', 'restricted', 'high_demand']).default('campus'),
  isActive: z.boolean().default(true),
  alertOnExit: z.boolean().default(false),
  alertOnEntry: z.boolean().default(false),
});

export type CreateGeofenceInput = z.infer<typeof createGeofenceSchema>;

