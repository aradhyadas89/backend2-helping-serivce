import { z } from 'zod';

export const listAlertsQuerySchema = z.object({
  status: z.enum(['open', 'acknowledged', 'resolved', 'dismissed']).optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  alertType: z
    .enum([
      'rooted_or_jailbroken',
      'emulator_detected',
      'speed_violation',
      'geofence_breach',
      'critical_low_battery',
      'mocked_location_spoofing',
    ])
    .optional(),
  role: z.enum(['user', 'partner', 'admin']).optional(),
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? Math.max(1, Math.min(200, parseInt(val, 10))) : 50)),
  page: z
    .string()
    .optional()
    .transform((val) => (val ? Math.max(1, parseInt(val, 10)) : 1)),
});

export const updateAlertStatusSchema = z.object({
  status: z.enum(['acknowledged', 'resolved', 'dismissed']),
  note: z.string().optional(),
});

