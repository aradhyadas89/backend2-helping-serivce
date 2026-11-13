import { z } from 'zod';

export const registerPartnerSchema = z.object({
  partnerId: z.string().optional(),
  name: z.string().min(2, 'Name must be at least 2 characters'),
  email: z.string().email('Invalid email address'),
  phone: z.string().min(10, 'Phone must be at least 10 digits'),
  transportMode: z.enum(['cycle', 'walk']).default('cycle'),
});

export type RegisterPartnerInput = z.infer<typeof registerPartnerSchema>;

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

export const partnerMarkReachedSchema = z.object({
  stage: z.enum(['cash', 'delivery']),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});

