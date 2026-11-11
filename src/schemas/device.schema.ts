import { z } from 'zod';

export const deviceStreamEventSchema = z.object({
  id: z.string().optional(),
  userId: z.string().min(1, 'userId is required'),
  userName: z.string().optional().default(''),
  userEmail: z.string().optional().default(''),
  role: z.enum(['user', 'partner', 'admin']).default('user'),
  osName: z.enum(['ios', 'android', 'web', 'windows', 'macos', 'linux', 'other']),
  osVersion: z.string().optional().default('unknown'),
  deviceBrand: z.string().optional().default('unknown'),
  deviceModel: z.string().optional().default('unknown'),
  deviceType: z.enum(['mobile', 'tablet', 'desktop', 'other']).default('mobile'),
  appVersion: z.string().optional(),
  buildNumber: z.string().optional(),
  ipAddress: z.string().optional(),
  userAgent: z.string().optional(),
  screenResolution: z.string().optional(),
  deviceMemory: z.string().optional(),
  networkType: z.string().optional(),
  carrier: z.string().optional(),
  batteryLevel: z.number().min(0).max(100).optional(),
  isCharging: z.boolean().optional(),
  lowPowerMode: z.boolean().optional(),
  isEmulator: z.boolean().optional().default(false),
  isRootedOrJailbroken: z.boolean().optional().default(false),
  timestamp: z
    .union([z.string(), z.date()])
    .transform((val) => new Date(val))
    .default(() => new Date()),
});

export type DeviceStreamEventInput = z.input<typeof deviceStreamEventSchema>;
export type DeviceStreamEventOutput = z.infer<typeof deviceStreamEventSchema>;

export const deviceAnalyticsQuerySchema = z.object({
  timeframe: z.enum(['24h', '7d', '30d', 'all']).default('7d'),
  role: z.enum(['user', 'partner', 'admin']).optional(),
});

export const deviceStreamQuerySchema = z.object({
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? Math.max(1, Math.min(500, parseInt(val, 10))) : 100)),
  since: z
    .string()
    .optional()
    .transform((val) => (val ? new Date(val) : undefined)),
  osName: z.enum(['ios', 'android', 'web', 'windows', 'macos', 'linux', 'other']).optional(),
  role: z.enum(['user', 'partner', 'admin']).optional(),
});

