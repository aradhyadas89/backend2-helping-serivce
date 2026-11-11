import { z } from 'zod';

export const syncUserAnalysisSchema = z.object({
  userId: z.string().min(1, 'userId is required'),
  segments: z.array(z.string()).default([]),
  boostCategories: z.array(z.string()).default([]),
  suppressCategories: z.array(z.string()).default([]),
  preferredPriceTier: z.enum(['budget', 'mid', 'premium']).optional(),
  customWeights: z.record(z.number()).default({}),
  categoryAffinities: z
    .array(
      z.object({
        category: z.string(),
        weight: z.number().min(0).max(100),
      })
    )
    .optional(),
  tagWeights: z
    .array(
      z.object({
        tag: z.string(),
        weight: z.number().min(0).max(100),
      })
    )
    .optional(),
});

export type SyncUserAnalysisInput = z.infer<typeof syncUserAnalysisSchema>;

export const triggerAnalysisQuerySchema = z.object({
  userId: z.string().optional(),
  forceFullRecalculation: z
    .string()
    .optional()
    .transform((val) => val === 'true'),
});

