import { Router, Request, Response, NextFunction } from 'express';
import { validateBody, validateQuery } from '../middlewares/validate';
import {
  createOrderSchema,
  selectPaymentModeSchema,
  verifyOtpSchema,
  verifyRazorpayPaymentSchema,
  queryOrdersSchema,
} from '../schemas/order.schema';
import { orderService } from '../services/order.service';
import { getOrderModel } from '../models/Order';
import { sendSuccess } from '../utils/response.utils';
import { NotFoundException } from '../middlewares/errorHandler';

const router = Router();

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
        Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
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
 * @route   GET /api/v1/orders/:orderId
 * @desc    Get order details, current status, and billing breakdown
 */
router.get('/:orderId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const Order = getOrderModel();
    const order = await Order.findOne({ orderId: req.params.orderId }).lean();

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
 * @desc    User selects payment mode (ONLINE or OFFLINE) within 1-minute window
 */
router.post(
  '/:orderId/select-payment',
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

      return sendSuccess(res, order, `Payment mode ${req.body.paymentMode} selected successfully.`);
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
        req.body.razorpayPaymentId
      );

      return sendSuccess(res, order, 'Online payment verified successfully. Partner wallet credited.');
    } catch (error) {
      next(error);
    }
  }
);

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

export default router;

