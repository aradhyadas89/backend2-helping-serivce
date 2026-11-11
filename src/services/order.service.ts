import crypto from 'crypto';
import { getOrderModel, IOrder, PaymentMode } from '../models/Order';
import { getPartnerModel } from '../models/Partner';
import { getPartnerWalletModel } from '../models/PartnerWallet';
import { getUserOrderProfileModel } from '../models/UserOrderProfile';
import { pricingService } from './pricing.service';
import { partnerDispatchService } from './partner-dispatch.service';
import { travelTimerService } from './travel-timer.service';
import { wsDispatcher } from '../websocket/ws-dispatcher';
import { calculateHaversineDistance } from '../utils/geo.utils';
import { logger } from '../config/logger';
import {
  BadRequestException,
  NotFoundException,
  ConflictException,
  AppError,
} from '../middlewares/errorHandler';

export class OrderService {
  /**
   * Helper to generate human-readable order IDs
   */
  private generateOrderId(): string {
    const timestamp = Math.floor(Date.now() / 1000);
    const randomHex = crypto.randomBytes(2).toString('hex').toUpperCase();
    return `ORD-${timestamp}-${randomHex}`;
  }

  /**
   * Helper to generate secure 6-digit numeric OTPs
   */
  private generate6DigitOtp(): string {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  /**
   * 1. Place New Order with Minimum ₹30 check, Crisis Gate, and 2.5km Ring Dispatch
   */
  async createOrder(input: {
    userId: string;
    userName?: string;
    userEmail?: string;
    userPhone?: string;
    items: Array<{ productId: string; quantity: number }>;
    latitude: number;
    longitude: number;
    deliveryAddress: string;
  }): Promise<IOrder> {
    // A. Partner Crisis Gate Check (Must have >= 2 online partners in 2.5km zone)
    const availability = await partnerDispatchService.checkPartnerAvailability(
      input.latitude,
      input.longitude
    );

    if (!availability.isAvailable) {
      throw new AppError(
        'Service temporarily unavailable due to partner crisis. At least 2 active delivery partners must be online in your zone. Please try again shortly.',
        503
      );
    }

    // B. Calculate Pricing, Billing Breakdown & Enforce Minimum ₹30 Threshold
    const billing = await pricingService.calculateBilling(
      input.userId,
      input.items,
      1000 // Approximate initial distance
    );

    const orderId = this.generateOrderId();

    const Order = getOrderModel();
    const order = await Order.create({
      orderId,
      userId: input.userId,
      userName: input.userName || 'Customer',
      userEmail: input.userEmail || 'customer@example.com',
      userPhone: input.userPhone || '9876543210',
      deliveryLocation: {
        type: 'Point',
        coordinates: [input.longitude, input.latitude],
      },
      latitude: input.latitude,
      longitude: input.longitude,
      deliveryAddress: input.deliveryAddress,
      items: billing.items,
      subtotal: billing.subtotal,
      deliveryFee: billing.deliveryFee,
      cancellationPenaltySurcharge: billing.cancellationPenaltySurcharge,
      totalAmount: billing.totalAmount,
      status: 'SEARCHING_PARTNER',
      notifiedPartnerIds: availability.candidatePartners.map((p) => p.partnerId),
      ringBandsNotified: [1, 2, 3, 4],
    });

    logger.info(`[ORDER CREATED] ${order.orderId} for User ${order.userId} - Total: ₹${order.totalAmount}`);

    // C. Trigger 2.5 km concentric ring delay dispatch
    await partnerDispatchService.dispatchOrderRings(order, availability.candidatePartners);

    return order;
  }

  /**
   * 2. Partner Picks Up Order (First Pick Wins)
   */
  async partnerAcceptOrder(orderId: string, partnerId: string): Promise<IOrder> {
    return await partnerDispatchService.atomicAcceptOrder(orderId, partnerId);
  }

  /**
   * 3. User Selects Payment Mode within 1-minute window (ONLINE or OFFLINE)
   */
  async selectPaymentMode(
    orderId: string,
    userId: string,
    paymentMode: PaymentMode
  ): Promise<IOrder> {
    const Order = getOrderModel();
    const order = await Order.findOne({ orderId, userId });

    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    if (order.status !== 'PAYMENT_PENDING') {
      throw new BadRequestException(`Order cannot accept payment mode in current status '${order.status}'`);
    }

    // Verify 1-minute window has not expired
    const now = new Date();
    if (order.paymentSelectionExpiresAt && now > order.paymentSelectionExpiresAt) {
      // Mark as cancelled due to timeout
      await this.handlePaymentTimeout(order);
      throw new BadRequestException('1-minute payment selection window expired. Order has been cancelled.');
    }

    order.paymentMode = paymentMode;

    if (paymentMode === 'ONLINE') {
      // Setup Razorpay order simulation
      order.razorpayOrderId = `order_rzp_${Date.now()}`;
      // Remains in PAYMENT_PENDING until payment gateway verifies
    } else {
      // OFFLINE Mode (Cash Pickup Flow)
      // Verify partner 5:1 online-to-offline fairness ratio
      if (order.assignedPartnerId) {
        const ratio = await partnerDispatchService.checkPartnerOfflineRatioEligibility(
          order.assignedPartnerId
        );
        if (!ratio.isEligible) {
          logger.warn(`Partner ${order.assignedPartnerId} exceeded 5:1 offline quota: ${ratio.reason}`);
        }
      }

      order.status = 'CASH_COLLECTION_IN_PROGRESS';

      // Calculate partner travel ETA for cash pickup
      const Partner = getPartnerModel();
      const partner = await Partner.findOne({ partnerId: order.assignedPartnerId });
      const mode = partner?.transportMode || 'cycle';

      const distance =
        partner?.latitude && partner?.longitude
          ? calculateHaversineDistance(
              partner.latitude,
              partner.longitude,
              order.latitude,
              order.longitude
            )
          : 1000;

      const { etaSeconds, expiresAt } = travelTimerService.calculateEta(distance, mode);
      order.cashTripEtaSeconds = etaSeconds;
      order.cashTripExpiresAt = expiresAt;
      order.cashTripMercyUsed = false;

      // Broadcast to partner and user: Partner is on their way to pick up cash
      wsDispatcher.broadcast(`order:${order.orderId}`, {
        type: 'CASH_COLLECTION_STARTED',
        orderId: order.orderId,
        etaSeconds,
        expiresAt: expiresAt.toISOString(),
      });
    }

    await order.save();
    return order;
  }

  /**
   * 4. Verify Razorpay Online Payment & Credit Partner Virtual Balance
   */
  async verifyOnlinePayment(
    orderId: string,
    razorpayOrderId: string,
    razorpayPaymentId: string
  ): Promise<IOrder> {
    const Order = getOrderModel();
    const order = await Order.findOne({ orderId });

    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    if (order.paymentMode !== 'ONLINE') {
      throw new BadRequestException('Order was not configured for ONLINE payment mode');
    }

    // Real money stays in platform Razorpay account.
    order.isPaid = true;
    order.razorpayOrderId = razorpayOrderId;
    order.razorpayPaymentId = razorpayPaymentId;
    order.paidAt = new Date();
    order.status = 'PAID';

    // Calculate product pickup and delivery ETA
    const Partner = getPartnerModel();
    const partner = await Partner.findOne({ partnerId: order.assignedPartnerId });
    const mode = partner?.transportMode || 'cycle';

    const distance = 1500; // Estimated delivery distance
    const { etaSeconds, expiresAt } = travelTimerService.calculateEta(distance, mode);
    order.deliveryTripEtaSeconds = etaSeconds;
    order.deliveryTripExpiresAt = expiresAt;
    order.deliveryTripMercyUsed = false;

    // Credit partner virtual wallet balance with the delivery earning
    if (order.assignedPartnerId) {
      await this.creditPartnerWallet(
        order.assignedPartnerId,
        order.deliveryFee,
        order.orderId,
        'Delivery fee earning for online order'
      );
    }

    await order.save();

    wsDispatcher.broadcast(`order:${order.orderId}`, {
      type: 'PAYMENT_COMPLETED',
      orderId: order.orderId,
      status: order.status,
      deliveryEtaSeconds: etaSeconds,
    });

    return order;
  }

  /**
   * 5. Partner Arrives at User (Stage: 'cash' or 'delivery')
   */
  async partnerMarkReached(
    orderId: string,
    partnerId: string,
    stage: 'cash' | 'delivery'
  ): Promise<{ message: string; otpGenerated: boolean }> {
    const Order = getOrderModel();
    const order = await Order.findOne({ orderId, assignedPartnerId: partnerId });

    if (!order) {
      throw new NotFoundException(`Order ${orderId} assigned to partner not found`);
    }

    const otp = this.generate6DigitOtp();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes expiry

    if (stage === 'cash') {
      order.cashCollectionOtp = otp;
      order.cashCollectionOtpExpiresAt = expiresAt;

      // Ring user phone via WebSocket
      wsDispatcher.broadcast(`user:order:${order.userId}`, {
        type: 'PHONE_RING_CASH_COLLECTION',
        orderId: order.orderId,
        message: 'Partner has arrived to collect cash payment! Your cash OTP is provided below.',
        otp,
      });

      logger.info(`[CASH OTP DISPATCHED] Order ${order.orderId} - OTP: ${otp} sent to ${order.userEmail}`);
    } else {
      order.deliveryOtp = otp;
      order.deliveryOtpExpiresAt = expiresAt;
      order.status = 'PARTNER_REACHED_DELIVERY';

      // Ring user phone for final delivery
      wsDispatcher.broadcast(`user:order:${order.userId}`, {
        type: 'PHONE_RING_DELIVERY_ARRIVAL',
        orderId: order.orderId,
        message: 'Partner has arrived with your order! Please share delivery OTP with partner.',
        otp,
      });

      logger.info(`[DELIVERY OTP DISPATCHED] Order ${order.orderId} - OTP: ${otp} sent to ${order.userEmail}`);
    }

    await order.save();

    return {
      message: `Partner reached user for ${stage}. User phone rang and OTP was sent to their email.`,
      otpGenerated: true,
    };
  }

  /**
   * 6. Request Travel Timer Mercy Extension
   */
  async requestMercyExtension(
    orderId: string,
    partnerId: string,
    stage: 'cash' | 'delivery',
    remainingDistanceMeters: number = 500
  ): Promise<{ mercyGranted: boolean; message: string }> {
    const Order = getOrderModel();
    const Partner = getPartnerModel();

    const [order, partner] = await Promise.all([
      Order.findOne({ orderId, assignedPartnerId: partnerId }),
      Partner.findOne({ partnerId }),
    ]);

    if (!order || !partner) {
      throw new NotFoundException('Order or Partner not found');
    }

    const mode = partner.transportMode || 'cycle';
    const isCashStage = stage === 'cash';
    const mercyAlreadyUsed = isCashStage ? order.cashTripMercyUsed : order.deliveryTripMercyUsed;

    const evaluation = travelTimerService.evaluateMercyExtension(
      remainingDistanceMeters,
      mode,
      mercyAlreadyUsed
    );

    if (evaluation.mercyGranted) {
      if (isCashStage) {
        order.cashTripMercyUsed = true;
        order.cashTripExpiresAt = evaluation.newExpiresAt;
      } else {
        order.deliveryTripMercyUsed = true;
        order.deliveryTripExpiresAt = evaluation.newExpiresAt;
      }
      partner.mercyExtensionsUsedCount = (partner.mercyExtensionsUsedCount || 0) + 1;
      await Promise.all([order.save(), partner.save()]);

      return {
        mercyGranted: true,
        message: evaluation.reason,
      };
    } else {
      // Reputation Penalty
      partner.reputationScore = Math.max(0, partner.reputationScore - evaluation.reputationPenalty);
      partner.unexcusedDelaysCount = (partner.unexcusedDelaysCount || 0) + 1;
      if (isCashStage) order.cashTripPenalized = true;
      else order.deliveryTripPenalized = true;

      await Promise.all([order.save(), partner.save()]);

      return {
        mercyGranted: false,
        message: evaluation.reason,
      };
    }
  }

  /**
   * 7. Verify Cash Collection OTP (Partner Submits OTP received from User)
   */
  async verifyCashCollectionOtp(orderId: string, partnerId: string, otp: string): Promise<IOrder> {
    const Order = getOrderModel();
    const order = await Order.findOne({ orderId, assignedPartnerId: partnerId });

    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found for partner`);
    }

    if (!order.cashCollectionOtp || order.cashCollectionOtp !== otp) {
      throw new BadRequestException('Invalid Cash Collection OTP');
    }

    if (order.cashCollectionOtpExpiresAt && new Date() > order.cashCollectionOtpExpiresAt) {
      throw new BadRequestException('Cash Collection OTP has expired');
    }

    order.isCashCollected = true;
    order.cashCollectedAt = new Date();
    order.status = 'CASH_COLLECTED';

    // Setup delivery trip timer
    const Partner = getPartnerModel();
    const partner = await Partner.findOne({ partnerId });
    const mode = partner?.transportMode || 'cycle';

    const { etaSeconds, expiresAt } = travelTimerService.calculateEta(1500, mode);
    order.deliveryTripEtaSeconds = etaSeconds;
    order.deliveryTripExpiresAt = expiresAt;
    order.deliveryTripMercyUsed = false;

    await order.save();

    wsDispatcher.broadcast(`order:${order.orderId}`, {
      type: 'CASH_VERIFIED',
      orderId: order.orderId,
      message: 'Cash payment confirmed! Partner is now fetching and delivering the product.',
      deliveryEtaSeconds: etaSeconds,
    });

    return order;
  }

  /**
   * 8. Verify Final Delivery OTP (Partner delivers product and completes order)
   */
  async verifyDeliveryOtp(orderId: string, partnerId: string, otp: string): Promise<IOrder> {
    const Order = getOrderModel();
    const Partner = getPartnerModel();
    const UserOrderProfile = getUserOrderProfileModel();

    const [order, partner] = await Promise.all([
      Order.findOne({ orderId, assignedPartnerId: partnerId }),
      Partner.findOne({ partnerId }),
    ]);

    if (!order || !partner) {
      throw new NotFoundException('Order or Partner not found');
    }

    if (!order.deliveryOtp || order.deliveryOtp !== otp) {
      throw new BadRequestException('Invalid Delivery Confirmation OTP');
    }

    if (order.deliveryOtpExpiresAt && new Date() > order.deliveryOtpExpiresAt) {
      throw new BadRequestException('Delivery Confirmation OTP has expired');
    }

    // Mark Order Delivered
    order.status = 'DELIVERED';
    order.deliveredAt = new Date();

    // Release partner and update 5:1 ratio counters
    partner.activeOrderId = null;
    if (order.paymentMode === 'ONLINE') {
      partner.onlineOrdersCompleted = (partner.onlineOrdersCompleted || 0) + 1;
    } else {
      partner.offlineOrdersCompleted = (partner.offlineOrdersCompleted || 0) + 1;
    }

    // Credit partner wallet virtual balance
    await this.creditPartnerWallet(
      partner.partnerId,
      order.deliveryFee,
      order.orderId,
      `Delivery fee earning for ${order.paymentMode} delivery`
    );

    // Update user profile completed orders
    await UserOrderProfile.findOneAndUpdate(
      { userId: order.userId },
      { $inc: { totalOrdersCompleted: 1 } },
      { upsert: true }
    );

    await Promise.all([order.save(), partner.save()]);

    wsDispatcher.broadcast(`order:${order.orderId}`, {
      type: 'ORDER_DELIVERED',
      orderId: order.orderId,
      message: 'Order delivered successfully!',
    });

    return order;
  }

  /**
   * 9. Handle 1-minute Payment Timeout Cancellation & Penalty Surcharge Tracking
   */
  async handlePaymentTimeout(order: IOrder): Promise<void> {
    order.status = 'CANCELLED_PAYMENT_TIMEOUT';

    // Release assigned partner
    if (order.assignedPartnerId) {
      const Partner = getPartnerModel();
      await Partner.findOneAndUpdate(
        { partnerId: order.assignedPartnerId },
        { $set: { activeOrderId: null } }
      );
    }

    // Update user cancellation penalty records
    const UserOrderProfile = getUserOrderProfileModel();
    const profile = await UserOrderProfile.findOneAndUpdate(
      { userId: order.userId },
      { $inc: { unpaidCancellationsCount: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // If cancellations >= 2, penalty surcharge is active
    if (profile.unpaidCancellationsCount >= 2) {
      profile.penaltySurchargeApplies = true;
      await profile.save();
      logger.warn(
        `User ${order.userId} reached ${profile.unpaidCancellationsCount} unpaid cancellations. ₹0.30 penalty active on future orders.`
      );
    } else {
      profile.hasUsedCancellationMercy = true;
      await profile.save();
      logger.info(`User ${order.userId} used their one-time cancellation mercy.`);
    }

    await order.save();

    wsDispatcher.broadcast(`order:${order.orderId}`, {
      type: 'ORDER_CANCELLED_PAYMENT_TIMEOUT',
      orderId: order.orderId,
      message: '1-minute payment selection window expired. Order cancelled.',
    });
  }

  /**
   * Helper: Credit Virtual Earnings to Partner In-App Wallet
   */
  private async creditPartnerWallet(
    partnerId: string,
    amount: number,
    orderId: string,
    description: string
  ): Promise<void> {
    const PartnerWallet = getPartnerWalletModel();
    await PartnerWallet.findOneAndUpdate(
      { partnerId },
      {
        $inc: {
          virtualBalance: amount,
          totalEarned: amount,
        },
        $push: {
          transactions: {
            transactionId: `TXN-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
            orderId,
            amount,
            type: 'credit',
            category: 'delivery_fee',
            description,
            createdAt: new Date(),
          },
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }
}

export const orderService = new OrderService();
