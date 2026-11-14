import { z } from 'zod';

export const registerPartnerSchema = z.object({
  partnerId: z.string().optional(),
  name: z.string().min(2, 'Name must be at least 2 characters'),
  email: z.string().email('Invalid email address'),
  phone: z.string().min(10, 'Phone must be at least 10 digits'),
  password: z.string().min(6, 'Password must be at least 6 characters').optional().default('Partner@123'),
  transportMode: z.enum(['cycle', 'walk']).default('cycle'),
});

export type RegisterPartnerInput = z.infer<typeof registerPartnerSchema>;

export const loginPartnerSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

export type LoginPartnerInput = z.infer<typeof loginPartnerSchema>;

export const togglePartnerOnlineSchema = z.object({
  isOnline: z.boolean(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

export type TogglePartnerOnlineInput = z.infer<typeof togglePartnerOnlineSchema>;

export const partnerUpdateLocationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  speed: z.number().min(0).optional(),
  heading: z.number().min(0).max(360).optional(),
});

export const partnerLivePingSchema = z.object({
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  speed: z.number().min(0).optional(),
  heading: z.number().min(0).max(360).optional(),
  batteryLevel: z.number().min(0).max(100).optional(),
  isCharging: z.boolean().optional(),
  networkStatus: z.enum(['wifi', '4g', '5g', '3g', 'offline']).optional(),
});

export type PartnerLivePingInput = z.infer<typeof partnerLivePingSchema>;

export const partnerMarkReachedSchema = z.object({
  stage: z.enum(['cash', 'delivery']),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});

export const rateOrderSchema = z.object({
  rating: z.number().min(1).max(5),
  feedback: z.string().max(500).optional(),
});

export type RateOrderInput = z.infer<typeof rateOrderSchema>;
