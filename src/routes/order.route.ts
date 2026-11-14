import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { validateBody, validateQuery } from '../middlewares/validate';
import {
  createOrderSchema,
  selectPaymentModeSchema,
  verifyOtpSchema,
  verifyRazorpayPaymentSchema,
  queryOrdersSchema,
  calculateBillSchema,
  createAssignmentOrderSchema,
  calculateAssignmentBillSchema,
  updateAssignmentStageSchema,
  createPrintingOrderSchema,
  calculatePrintingBillSchema,
  updatePrintingStageSchema,
  proximityRingSchema,
} from '../schemas/order.schema';
import { rateOrderSchema } from '../schemas/partner.schema';
import { orderService } from '../services/order.service';
import { pricingService } from '../services/pricing.service';
import { partnerDispatchService } from '../services/partner-dispatch.service';
import { googleDriveService } from '../services/google-drive.service';
import { getOrderModel } from '../models/Order';
import { sendSuccess } from '../utils/response.utils';
import { NotFoundException } from '../middlewares/errorHandler';
import { razorpayService } from '../services/razorpay.service';
import { env } from '../config/env';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB max document/image size
});

/**
 * @route   POST /api/v1/orders/webhook/razorpay
 * @desc    Receive and process asynchronous Razorpay Webhooks (payment.captured, order.paid, etc.)
 */
router.post('/webhook/razorpay', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const signature = (req.headers['x-razorpay-signature'] as string) || '';
    const rawBody = (req as any).rawBody || JSON.stringify(req.body);

    const isValid = razorpayService.verifyWebhookSignature(rawBody, signature);
    if (!isValid && env.ENVIRONMENT === 'production') {
      return res.status(400).json({ success: false, error: { code: 400, message: 'Invalid webhook signature' } });
    }

    const { event, payload } = req.body;
    const result = await orderService.handleRazorpayWebhook(event, payload);

    return res.status(200).json({ success: true, message: result.message });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/v1/orders
 * @desc    Place a new order (enforces ₹30 min, partner crisis gate, 2.5km ring dispatch)
 */
router.post(
  '/',
  validateBody(createOrderSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.userId || req.body.userId || 'guest_user';
      const order = await orderService.createOrder({
        userId,
        userName: req.body.userName,
        userEmail: req.body.userEmail,
        userPhone: req.body.userPhone,
        items: req.body.items,
        latitude: req.body.latitude,
        longitude: req.body.longitude,
        deliveryAddress: req.body.deliveryAddress,
      });

      return sendSuccess(res, order, 'Order created successfully. Searching for nearby partners.', 201);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/v1/orders
 * @desc    List orders with filtering
 */
router.get(
  '/',
  validateQuery(queryOrdersSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { status, userId, partnerId, limit, page } = req.query as any;
      const Order = getOrderModel();
      const filter: Record<string, any> = {};

      if (status) filter.status = status;
      if (userId) filter.userId = userId;
      if (partnerId) filter.assignedPartnerId = partnerId;

      const skip = (page - 1) * limit;
      const [orders, total] = await Promise.all([
        Order.find(filter)
          .select('-cashCollectionOtp -deliveryOtp')
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .lean(),
        Order.countDocuments(filter),
      ]);

      return sendSuccess(res, orders, 'Orders retrieved successfully', 200, {
        total,
        count: orders.length,
        meta: { page, totalPages: Math.ceil(total / limit) || 1 },
      });
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /api/v1/orders/calculate-bill
 * @desc    Preview bill breakdown, delivery fee, threshold requirement, and penalty surcharge
 */
router.post(
  '/calculate-bill',
  validateBody(calculateBillSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.userId || req.body.userId || 'guest_user';
      const result = await pricingService.estimateBilling(
        userId,
        req.body.items,
        req.body.approxDistanceMeters || 1000
      );

      return sendSuccess(res, result, 'Bill breakdown calculated successfully');
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /api/v1/orders/assignment
 * @desc    Book a partner for handwritten assignment writing (₹1 writing + ₹1 paper per page)
 */
router.post(
  '/assignment',
  validateBody(createAssignmentOrderSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.userId || req.body.userId || 'guest_user';
      const order = await orderService.createAssignmentOrder({
        ...req.body,
        userId,
      });

      return sendSuccess(
        res,
        order,
        'Assignment writing order created successfully! Ringing nearby partners in 2.5km zone.',
        201
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /api/v1/orders/calculate-assignment-bill
 * @desc    Preview assignment bill (₹1 writing + ₹1 page price) and estimated handwriting time
 */
router.post(
  '/calculate-assignment-bill',
  validateBody(calculateAssignmentBillSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.userId || req.body.userId || 'guest_user';
      const result = await orderService.calculateAssignmentBilling({
        userId,
        assignmentText: req.body.assignmentText,
        pageCount: req.body.pageCount,
        approxDistanceMeters: req.body.approxDistanceMeters,
      });

      return sendSuccess(res, result, 'Assignment writing bill calculated successfully');
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /api/v1/orders/printing
 * @desc    Order document printing: upload image to Google Drive, ring partners in 2.5km zone
 */
router.post(
  '/printing',
  upload.single('file'),
  validateBody(createPrintingOrderSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.userId || req.body.userId || 'guest_user';
      const order = await orderService.createPrintingOrder(
        {
          ...req.body,
          userId,
        },
        req.file
      );

      return sendSuccess(
        res,
        order,
        'Printing order created and document stored in Google Drive. Ringing nearby partners in 2.5km zone.',
        201
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /api/v1/orders/calculate-printing-bill
 * @desc    Preview document printing bill breakdown (BW ₹2/page, Color ₹10/page)
 */
router.post(
  '/calculate-printing-bill',
  validateBody(calculatePrintingBillSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.userId || req.body.userId || 'guest_user';
      const result = await orderService.calculatePrintingBilling({
        userId,
        pageCount: req.body.pageCount,
        copies: req.body.copies,
        colorMode: req.body.colorMode,
        approxDistanceMeters: req.body.approxDistanceMeters,
      });

      return sendSuccess(res, result, 'Printing bill calculated successfully');
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/v1/orders/print-document/:fileId
 * @desc    Download stored document/image (proxy from Google Drive/local storage)
 */
router.get('/print-document/:fileId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const file = await googleDriveService.getFile(req.params.fileId);
    if (!file) {
      throw new NotFoundException(`Document ${req.params.fileId} not found in storage`);
    }

    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${file.fileName}"`);
    return res.send(file.buffer);
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/v1/orders/user/:userId/active
 * @desc    Get currently active in-progress order for customer
 */
router.get('/user/:userId/active', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const activeOrder = await orderService.getUserActiveOrder(req.params.userId);
    return sendSuccess(res, activeOrder, activeOrder ? 'Active order retrieved' : 'No active orders in progress');
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/v1/orders/rush-status
 * @desc    Inspect current order rush and partner load in 2.5km delivery zone
 */
router.get('/rush-status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const latitude = parseFloat(req.query.latitude as string) || 22.5726;
    const longitude = parseFloat(req.query.longitude as string) || 88.3639;

    const rush = await partnerDispatchService.detectOrderRush(latitude, longitude);
    return sendSuccess(res, rush, 'Order rush and capacity status evaluated');
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/v1/orders/:orderId
 * @desc    Get order details, current status, and billing breakdown
 */
router.get('/:orderId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const Order = getOrderModel();
    const order = await Order.findOne({ orderId: req.params.orderId })
      .select('-cashCollectionOtp -deliveryOtp')
      .lean();

    if (!order) {
      throw new NotFoundException(`Order ${req.params.orderId} not found`);
    }

    return sendSuccess(res, order, 'Order details retrieved');
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/v1/orders/:orderId/partner-accept
 * @desc    Partner picks up the order (first pick wins atomic protection)
 */
router.post('/:orderId/partner-accept', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const partnerId = req.user?.userId || req.body.partnerId;
    if (!partnerId) {
      return res.status(400).json({ success: false, error: { code: 400, message: 'partnerId is required' } });
    }

    const order = await orderService.partnerAcceptOrder(req.params.orderId, partnerId);
    return sendSuccess(res, order, 'Order accepted successfully. 1-minute payment countdown started.');
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/v1/orders/:orderId/select-payment
 * @route   POST /api/v1/orders/:orderId/payment-mode
 * @desc    User selects payment mode (ONLINE or OFFLINE) within 1-minute window
 */
router.post(
  ['/:orderId/select-payment', '/:orderId/payment-mode'],
  validateBody(selectPaymentModeSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.userId || req.body.userId;
      if (!userId) {
        return res.status(400).json({ success: false, error: { code: 400, message: 'userId is required' } });
      }

      const order = await orderService.selectPaymentMode(
        req.params.orderId,
        userId,
        req.body.paymentMode
      );

      const orderObj = order.toObject ? order.toObject() : { ...order };
      if (order.paymentMode === 'ONLINE') {
        orderObj.razorpayKeyId = env.RAZORPAY_KEY_ID;
        orderObj.currency = 'INR';
        orderObj.amountInPaise = Math.round(order.totalAmount * 100);
      }

      return sendSuccess(res, orderObj, `Payment mode ${req.body.paymentMode} selected successfully.`);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /api/v1/orders/:orderId/verify-payment
 * @desc    Verify Razorpay online payment & credit partner virtual wallet
 */
router.post(
  '/:orderId/verify-payment',
  validateBody(verifyRazorpayPaymentSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const order = await orderService.verifyOnlinePayment(
        req.params.orderId,
        req.body.razorpayOrderId,
        req.body.razorpayPaymentId,
        req.body.razorpaySignature
      );

      return sendSuccess(res, order, 'Online payment verified successfully. Partner wallet credited.');
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/v1/orders/:orderId/payment-status
 * @desc    Get order payment status, gateway details, and refund status
 */
router.get('/:orderId/payment-status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const paymentStatus = await orderService.getOrderPaymentStatus(req.params.orderId);
    return sendSuccess(res, paymentStatus, 'Order payment status retrieved successfully');
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/v1/orders/:orderId/partner-reached
 * @desc    Partner marks arrival at user (rings user phone & dispatches OTP to email)
 */
router.post('/:orderId/partner-reached', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const partnerId = req.user?.userId || req.body.partnerId;
    const stage = req.body.stage as 'cash' | 'delivery';

    if (!partnerId || !stage) {
      return res.status(400).json({
        success: false,
        error: { code: 400, message: 'partnerId and stage ("cash" or "delivery") are required' },
      });
    }

    const result = await orderService.partnerMarkReached(req.params.orderId, partnerId, stage);
    return sendSuccess(res, result, result.message);
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/v1/orders/:orderId/verify-cash-otp
 * @desc    Partner submits the 6-digit cash collection OTP received from user
 */
router.post(
  '/:orderId/verify-cash-otp',
  validateBody(verifyOtpSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const partnerId = req.user?.userId || req.body.partnerId;
      if (!partnerId) {
        return res.status(400).json({ success: false, error: { code: 400, message: 'partnerId is required' } });
      }

      const order = await orderService.verifyCashCollectionOtp(
        req.params.orderId,
        partnerId,
        req.body.otp
      );

      return sendSuccess(res, order, 'Cash collection verified successfully. Partner proceed to fetch product.');
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /api/v1/orders/:orderId/verify-delivery-otp
 * @desc    Partner submits the 6-digit final delivery OTP received from user
 */
router.post(
  '/:orderId/verify-delivery-otp',
  validateBody(verifyOtpSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const partnerId = req.user?.userId || req.body.partnerId;
      if (!partnerId) {
        return res.status(400).json({ success: false, error: { code: 400, message: 'partnerId is required' } });
      }

      const order = await orderService.verifyDeliveryOtp(
        req.params.orderId,
        partnerId,
        req.body.otp
      );

      return sendSuccess(res, order, 'Order delivered successfully! Partner earnings credited.');
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /api/v1/orders/:orderId/request-mercy-extension
 * @desc    Partner requests one-time travel timer extension
 */
router.post('/:orderId/request-mercy-extension', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const partnerId = req.user?.userId || req.body.partnerId;
    const stage = req.body.stage as 'cash' | 'delivery';
    const remainingDistanceMeters = req.body.remainingDistanceMeters || 500;

    const result = await orderService.requestMercyExtension(
      req.params.orderId,
      partnerId,
      stage,
      remainingDistanceMeters
    );

    return sendSuccess(res, result, result.message);
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/v1/orders/:orderId/product-picked-up
 * @desc    Partner confirms product picked up from merchant -> transition to DELIVERY_IN_PROGRESS
 */
router.post('/:orderId/product-picked-up', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const partnerId = req.user?.userId || req.body.partnerId;
    const order = await orderService.markProductPickedUp(req.params.orderId, partnerId);
    return sendSuccess(res, order, 'Product marked picked up. Delivery in progress.');
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/v1/orders/:orderId/cancel
 * @desc    Customer cancels active order before delivery
 */
router.post('/:orderId/cancel', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.userId || req.body.userId;
    const order = await orderService.cancelOrderByUser(req.params.orderId, userId, req.body.reason);
    return sendSuccess(res, order, 'Order cancelled successfully.');
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/v1/orders/:orderId/live-track
 * @desc    Get real-time tracking for customer/partner with dynamic ETA and stage
 */
router.get('/:orderId/live-track', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const liveTracking = await orderService.getLiveTracking(req.params.orderId);
    return sendSuccess(res, liveTracking, 'Live order tracking retrieved successfully');
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/v1/orders/:orderId/rate
 * @desc    Customer rates partner (1-5 stars + feedback) after delivery
 */
router.post(
  '/:orderId/rate',
  validateBody(rateOrderSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = req.user?.userId || req.body.userId;
      const { rating, feedback } = req.body;

      const result = await orderService.ratePartnerOrder(
        req.params.orderId,
        userId,
        rating,
        feedback
      );

      return sendSuccess(res, result, 'Thank you! Partner rated successfully.');
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/v1/orders/:orderId/print-document
 * @desc    Fetch and download print document for partner/user
 */
router.get('/:orderId/print-document', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const Order = getOrderModel();
    const order = await Order.findOne({ orderId: req.params.orderId });

    if (!order) {
      throw new NotFoundException(`Order ${req.params.orderId} not found`);
    }

    if (order.orderType !== 'DOCUMENT_PRINTING' || !order.printingDetails) {
      throw new NotFoundException('Order does not have a printable document');
    }

    const fileId = order.printingDetails.fileId;
    if (!fileId) {
      throw new NotFoundException('Document file ID is missing on this order');
    }

    const file = await googleDriveService.getFile(fileId);
    if (!file) {
      throw new NotFoundException(`File for order ${order.orderId} not found in Google Drive / storage`);
    }

    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${order.printingDetails.fileName}"`);
    return res.send(file.buffer);
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/v1/orders/:orderId/assignment/stage
 * @desc    Partner updates assignment writing stage (BUYING_PAGES -> WRITING_ASSIGNMENT -> OUT_FOR_DELIVERY)
 */
router.post(
  '/:orderId/assignment/stage',
  validateBody(updateAssignmentStageSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const partnerId = req.user?.userId || req.body.partnerId;
      if (!partnerId) {
        return res.status(400).json({ success: false, error: { code: 400, message: 'partnerId is required' } });
      }

      const order = await orderService.updateAssignmentStage(
        req.params.orderId,
        partnerId,
        req.body.stage
      );

      return sendSuccess(res, order, `Assignment stage updated to ${req.body.stage}`);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /api/v1/orders/:orderId/printing/stage
 * @desc    Partner updates document printing stage (PRINTING_IN_PROGRESS -> OUT_FOR_DELIVERY)
 */
router.post(
  '/:orderId/printing/stage',
  validateBody(updatePrintingStageSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const partnerId = req.user?.userId || req.body.partnerId;
      if (!partnerId) {
        return res.status(400).json({ success: false, error: { code: 400, message: 'partnerId is required' } });
      }

      const order = await orderService.updatePrintingStage(
        req.params.orderId,
        partnerId,
        req.body.stage
      );

      return sendSuccess(res, order, `Printing stage updated to ${req.body.stage}`);
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /api/v1/orders/:orderId/proximity-ring
 * @desc    Partner near user (<150m): rings user phone and sends delivery OTP
 */
router.post(
  '/:orderId/proximity-ring',
  validateBody(proximityRingSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const partnerId = req.user?.userId || req.body.partnerId;
      if (!partnerId) {
        return res.status(400).json({ success: false, error: { code: 400, message: 'partnerId is required' } });
      }

      const result = await orderService.triggerProximityRinging(
        req.params.orderId,
        partnerId,
        req.body.partnerLatitude,
        req.body.partnerLongitude
      );

      return sendSuccess(res, result, result.message);
    } catch (error) {
      next(error);
    }
  }
);

export default router;

