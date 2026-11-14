import { z } from 'zod';

export const createOrderSchema = z.object({
  userId: z.string().optional(),
  items: z
    .array(
      z.object({
        productId: z.string().min(1, 'Product ID is required'),
        quantity: z.number().int().min(1, 'Quantity must be at least 1'),
      })
    )
    .min(1, 'At least one item is required'),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  deliveryAddress: z.string().min(5, 'Delivery address must be at least 5 characters'),
  userName: z.string().optional(),
  userEmail: z.string().email().optional(),
  userPhone: z.string().min(10).optional(),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

export const selectPaymentModeSchema = z.object({
  userId: z.string().optional(),
  paymentMode: z.enum(['ONLINE', 'OFFLINE']),
});

export type SelectPaymentModeInput = z.infer<typeof selectPaymentModeSchema>;

export const verifyOtpSchema = z.object({
  partnerId: z.string().optional(),
  otp: z.string().regex(/^\d{6}$/, 'OTP must be exactly 6 numeric digits'),
});

export type VerifyOtpInput = z.infer<typeof verifyOtpSchema>;

export const verifyRazorpayPaymentSchema = z.object({
  razorpayOrderId: z.string().min(1),
  razorpayPaymentId: z.string().min(1),
  razorpaySignature: z.string().optional(),
});

export type VerifyRazorpayPaymentInput = z.infer<typeof verifyRazorpayPaymentSchema>;

export const calculateBillSchema = z.object({
  userId: z.string().optional(),
  items: z
    .array(
      z.object({
        productId: z.string().min(1, 'Product ID is required'),
        quantity: z.number().int().min(1, 'Quantity must be at least 1'),
      })
    )
    .min(1, 'At least one item is required'),
  approxDistanceMeters: z.number().min(0).optional().default(1000),
});

export type CalculateBillInput = z.infer<typeof calculateBillSchema>;

export const queryOrdersSchema = z.object({
  status: z.string().optional(),
  userId: z.string().optional(),
  partnerId: z.string().optional(),
  limit: z
    .string()
    .optional()
    .transform((val) => (val ? Math.max(1, Math.min(100, parseInt(val, 10))) : 20)),
  page: z
    .string()
    .optional()
    .transform((val) => (val ? Math.max(1, parseInt(val, 10)) : 1)),
});

// ==========================================
// Assignment Writing Schemas
// ==========================================
export const createAssignmentOrderSchema = z.object({
  userId: z.string().optional(),
  userName: z.string().optional(),
  userEmail: z.string().email().optional(),
  userPhone: z.string().min(10).optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  deliveryAddress: z.string().min(5, 'Delivery address must be at least 5 characters'),
  assignmentText: z.string().min(10, 'Assignment content must contain at least 10 characters'),
  explanation: z.string().min(5, 'Explanation/instructions on how to write must be at least 5 characters'),
  pageCount: z.number().int().min(1).optional(),
});

export type CreateAssignmentOrderInput = z.infer<typeof createAssignmentOrderSchema>;

export const calculateAssignmentBillSchema = z.object({
  userId: z.string().optional(),
  assignmentText: z.string().min(5),
  pageCount: z.number().int().min(1).optional(),
  approxDistanceMeters: z.number().min(0).optional().default(1000),
});

export type CalculateAssignmentBillInput = z.infer<typeof calculateAssignmentBillSchema>;

export const updateAssignmentStageSchema = z.object({
  partnerId: z.string().optional(),
  stage: z.enum(['BUYING_PAGES', 'WRITING_ASSIGNMENT', 'OUT_FOR_DELIVERY']),
});

export type UpdateAssignmentStageInput = z.infer<typeof updateAssignmentStageSchema>;

// ==========================================
// Document Printing Schemas
// ==========================================
export const createPrintingOrderSchema = z.object({
  userId: z.string().optional(),
  userName: z.string().optional(),
  userEmail: z.string().email().optional(),
  userPhone: z.string().min(10).optional(),
  latitude: z.coerce.number().min(-90).max(90),
  longitude: z.coerce.number().min(-180).max(180),
  deliveryAddress: z.string().min(5, 'Delivery address must be at least 5 characters'),
  pageCount: z.coerce.number().int().min(1),
  copies: z.coerce.number().int().min(1).optional().default(1),
  colorMode: z.enum(['BW', 'COLOR']).default('BW'),
  printSides: z.enum(['SINGLE', 'DOUBLE']).optional().default('SINGLE'),
  explanation: z.string().optional(),
  fileBase64: z.string().optional(),
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
});

export type CreatePrintingOrderInput = z.infer<typeof createPrintingOrderSchema>;

export const calculatePrintingBillSchema = z.object({
  userId: z.string().optional(),
  pageCount: z.coerce.number().int().min(1),
  copies: z.coerce.number().int().min(1).optional().default(1),
  colorMode: z.enum(['BW', 'COLOR']).default('BW'),
  approxDistanceMeters: z.coerce.number().min(0).optional().default(1000),
});

export type CalculatePrintingBillInput = z.infer<typeof calculatePrintingBillSchema>;

export const updatePrintingStageSchema = z.object({
  partnerId: z.string().optional(),
  stage: z.enum(['PRINTING_IN_PROGRESS', 'OUT_FOR_DELIVERY']),
});

export type UpdatePrintingStageInput = z.infer<typeof updatePrintingStageSchema>;

export const proximityRingSchema = z.object({
  partnerId: z.string().optional(),
  partnerLatitude: z.coerce.number().min(-90).max(90).optional(),
  partnerLongitude: z.coerce.number().min(-180).max(180).optional(),
});

export type ProximityRingInput = z.infer<typeof proximityRingSchema>;

