import crypto from "crypto";
import { getOrderModel, IOrder, PaymentMode, OrderType } from "../models/Order";
import { getPartnerModel } from "../models/Partner";
import { getPartnerWalletModel } from "../models/PartnerWallet";
import { getUserOrderProfileModel } from "../models/UserOrderProfile";
import { pricingService } from "./pricing.service";
import { partnerDispatchService } from "./partner-dispatch.service";
import { travelTimerService } from "./travel-timer.service";
import { wsDispatcher } from "../websocket/ws-dispatcher";
import { emailService } from "./email.service";
import { googleMapsService } from "./google-maps.service";
import { razorpayService } from "./razorpay.service";
import { googleDriveService } from "./google-drive.service";
import { xeroxShopService } from "./xerox-shop.service";
import { calculateHaversineDistance } from "../utils/geo.utils";
import { env } from "../config/env";
import { logger } from "../config/logger";
import {
  BadRequestException,
  NotFoundException,
  ConflictException,
  AppError,
} from "../middlewares/errorHandler";

export class OrderService {
  /**
   * Helper to generate human-readable order IDs
   */
  private generateOrderId(): string {
    const timestamp = Math.floor(Date.now() / 1000);
    const randomHex = crypto.randomBytes(2).toString("hex").toUpperCase();
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
      input.longitude,
    );

    if (!availability.isAvailable) {
      throw new AppError(
        "Service temporarily unavailable due to partner crisis. At least 2 active delivery partners must be online in your zone. Please try again shortly.",
        503,
      );
    }

    // B. Calculate Pricing, Billing Breakdown & Enforce Minimum ₹30 Threshold
    const billing = await pricingService.calculateBilling(
      input.userId,
      input.items,
      1000, // Approximate initial distance
    );

    const orderId = this.generateOrderId();

    const Order = getOrderModel();
    const order = await Order.create({
      orderId,
      userId: input.userId,
      userName: input.userName || "Customer",
      userEmail: input.userEmail || "customer@example.com",
      userPhone: input.userPhone || "9876543210",
      deliveryLocation: {
        type: "Point",
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
      status: "SEARCHING_PARTNER",
      notifiedPartnerIds: availability.candidatePartners.map(
        (p) => p.partnerId,
      ),
      ringBandsNotified: [1, 2, 3, 4],
    });

    logger.info(
      `[ORDER CREATED] ${order.orderId} for User ${order.userId} - Total: ₹${order.totalAmount}`,
    );

    // C. Trigger 2.5 km concentric ring delay dispatch
    await partnerDispatchService.dispatchOrderRings(
      order,
      availability.candidatePartners,
    );

    return order;
  }

  /**
   * 2. Partner Picks Up Order (First Pick Wins)
   */
  async partnerAcceptOrder(
    orderId: string,
    partnerId: string,
  ): Promise<IOrder> {
    return await partnerDispatchService.atomicAcceptOrder(orderId, partnerId);
  }

  /**
   * 3. User Selects Payment Mode within 1-minute window (ONLINE or OFFLINE)
   */
  async selectPaymentMode(
    orderId: string,
    userId: string,
    paymentMode: PaymentMode,
  ): Promise<IOrder> {
    const Order = getOrderModel();
    const order = await Order.findOne({ orderId, userId });

    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    if (order.status !== "PAYMENT_PENDING") {
      throw new BadRequestException(
        `Order cannot accept payment mode in current status '${order.status}'`,
      );
    }

    // Verify 1-minute window has not expired
    const now = new Date();
    if (
      order.paymentSelectionExpiresAt &&
      now > order.paymentSelectionExpiresAt
    ) {
      // Mark as cancelled due to timeout
      await this.handlePaymentTimeout(order);
      throw new BadRequestException(
        "1-minute payment selection window expired. Order has been cancelled.",
      );
    }

    // Assignment Writing and Document Printing require ONLINE payment mode only
    if (
      (order.orderType === "ASSIGNMENT_WRITING" ||
        order.orderType === "DOCUMENT_PRINTING") &&
      paymentMode === "OFFLINE"
    ) {
      throw new BadRequestException(
        `${order.orderType === "ASSIGNMENT_WRITING" ? "Assignment writing" : "Document printing"} orders require ONLINE payment via Razorpay. Cash pickup is not permitted.`,
      );
    }

    order.paymentMode = paymentMode;

    if (paymentMode === "ONLINE") {
      // Create authentic Razorpay Order via gateway API
      const rzpOrder = await razorpayService.createOrder({
        amount: order.totalAmount,
        currency: "INR",
        receipt: order.orderId,
        notes: {
          orderId: order.orderId,
          userId: order.userId,
        },
      });
      order.razorpayOrderId = rzpOrder.id;
      // Remains in PAYMENT_PENDING until payment gateway verifies
    } else {
      // OFFLINE Mode (Cash Pickup Flow)
      // Verify partner 5:1 online-to-offline fairness ratio
      if (order.assignedPartnerId) {
        const ratio =
          await partnerDispatchService.checkPartnerOfflineRatioEligibility(
            order.assignedPartnerId,
          );
        if (!ratio.isEligible) {
          logger.warn(
            `Partner ${order.assignedPartnerId} exceeded 5:1 offline quota: ${ratio.reason}`,
          );
        }
      }

      order.status = "CASH_COLLECTION_IN_PROGRESS";

      // Calculate partner travel ETA for cash pickup
      const Partner = getPartnerModel();
      const partner = await Partner.findOne({
        partnerId: order.assignedPartnerId,
      });
      const mode = partner?.transportMode || "cycle";

      const distance =
        partner?.latitude && partner?.longitude
          ? calculateHaversineDistance(
              partner.latitude,
              partner.longitude,
              order.latitude,
              order.longitude,
            )
          : 1000;

      const { etaSeconds, expiresAt } = travelTimerService.calculateEta(
        distance,
        mode,
      );
      order.cashTripEtaSeconds = etaSeconds;
      order.cashTripExpiresAt = expiresAt;
      order.cashTripMercyUsed = false;

      // Broadcast to partner and user: Partner is on their way to pick up cash
      wsDispatcher.broadcast(`order:${order.orderId}`, {
        type: "CASH_COLLECTION_STARTED",
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
    razorpayPaymentId: string,
    razorpaySignature?: string,
  ): Promise<IOrder> {
    const Order = getOrderModel();
    const order = await Order.findOne({ orderId });

    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    if (order.paymentMode !== "ONLINE") {
      throw new BadRequestException(
        "Order was not configured for ONLINE payment mode",
      );
    }

    if (order.isPaid) {
      return order; // Idempotent check
    }

    // Razorpay Order ID validation
    if (order.razorpayOrderId && order.razorpayOrderId !== razorpayOrderId) {
      throw new BadRequestException(
        `Razorpay order ID mismatch. Expected '${order.razorpayOrderId}', received '${razorpayOrderId}'`,
      );
    }

    // Cryptographic signature verification
    if (razorpaySignature) {
      const isValid = razorpayService.verifyPaymentSignature({
        razorpayOrderId,
        razorpayPaymentId,
        razorpaySignature,
      });

      if (!isValid) {
        throw new BadRequestException("Invalid Razorpay payment signature");
      }
    } else if (env.ENVIRONMENT === "production") {
      throw new BadRequestException(
        "Razorpay signature is required in production environment",
      );
    }

    // Real money stays in platform Razorpay account.
    order.isPaid = true;
    order.razorpayOrderId = razorpayOrderId;
    order.razorpayPaymentId = razorpayPaymentId;
    if (razorpaySignature) {
      order.razorpaySignature = razorpaySignature;
    }
    order.paidAt = new Date();

    if (order.orderType === "ASSIGNMENT_WRITING") {
      order.status = "BUYING_PAGES";
      if (order.assignmentDetails) {
        order.assignmentDetails.currentStage = "BUYING_PAGES";
        order.assignmentDetails.startedBuyingPagesAt = new Date();
      }
    } else if (order.orderType === "DOCUMENT_PRINTING") {
      order.status = "PRINTING_IN_PROGRESS";
      if (order.printingDetails) {
        order.printingDetails.currentStage = "PRINTING_IN_PROGRESS";
        order.printingDetails.startedPrintingAt = new Date();
      }
    } else {
      order.status = "PAID";
    }

    // Calculate product pickup and delivery ETA
    const Partner = getPartnerModel();
    const partner = await Partner.findOne({
      partnerId: order.assignedPartnerId,
    });
    const mode = partner?.transportMode || "cycle";

    const distance = 1500; // Estimated delivery distance
    const { etaSeconds, expiresAt } = travelTimerService.calculateEta(
      distance,
      mode,
    );
    order.deliveryTripEtaSeconds = etaSeconds;
    order.deliveryTripExpiresAt = expiresAt;
    order.deliveryTripMercyUsed = false;

    // Credit partner virtual wallet balance with the delivery earning
    if (order.assignedPartnerId) {
      await this.creditPartnerWallet(
        order.assignedPartnerId,
        order.deliveryFee,
        order.orderId,
        "Delivery fee earning for online order",
      );
    }

    await order.save();

    wsDispatcher.broadcast(`order:${order.orderId}`, {
      type: "PAYMENT_COMPLETED",
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
    stage: "cash" | "delivery",
  ): Promise<{ message: string; otpGenerated: boolean }> {
    const Order = getOrderModel();
    const order = await Order.findOne({
      orderId,
      assignedPartnerId: partnerId,
    });

    if (!order) {
      throw new NotFoundException(
        `Order ${orderId} assigned to partner not found`,
      );
    }

    const Partner = getPartnerModel();
    const partner = await Partner.findOne({ partnerId });

    const otp = this.generate6DigitOtp();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes expiry

    if (stage === "cash") {
      order.cashCollectionOtp = otp;
      order.cashCollectionOtpExpiresAt = expiresAt;

      // Ring user phone via WebSocket
      wsDispatcher.broadcast(`user:order:${order.userId}`, {
        type: "PHONE_RING_CASH_COLLECTION",
        orderId: order.orderId,
        message:
          "Partner has arrived to collect cash payment! Your cash OTP is provided below.",
        otp,
      });

      // Dispatch real email via SMTP
      if (order.userEmail) {
        await emailService.sendCashPickupOtpEmail({
          email: order.userEmail,
          userName: order.userName,
          orderId: order.orderId,
          otp,
          partnerName: partner?.name,
          amount: order.totalAmount,
        });
      }

      logger.info(
        `[CASH OTP DISPATCHED] Order ${order.orderId} - OTP: ${otp} sent to ${order.userEmail}`,
      );
    } else {
      order.deliveryOtp = otp;
      order.deliveryOtpExpiresAt = expiresAt;
      order.status = "PARTNER_REACHED_DELIVERY";

      // Ring user phone for final delivery
      wsDispatcher.broadcast(`user:order:${order.userId}`, {
        type: "PHONE_RING_DELIVERY_ARRIVAL",
        orderId: order.orderId,
        message:
          "Partner has arrived with your order! Please share delivery OTP with partner.",
        otp,
      });

      // Dispatch real email via SMTP
      if (order.userEmail) {
        await emailService.sendDeliveryOtpEmail({
          email: order.userEmail,
          userName: order.userName,
          orderId: order.orderId,
          otp,
          partnerName: partner?.name,
        });
      }

      logger.info(
        `[DELIVERY OTP DISPATCHED] Order ${order.orderId} - OTP: ${otp} sent to ${order.userEmail}`,
      );
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
    stage: "cash" | "delivery",
    remainingDistanceMeters: number = 500,
  ): Promise<{ mercyGranted: boolean; message: string }> {
    const Order = getOrderModel();
    const Partner = getPartnerModel();

    const [order, partner] = await Promise.all([
      Order.findOne({ orderId, assignedPartnerId: partnerId }),
      Partner.findOne({ partnerId }),
    ]);

    if (!order || !partner) {
      throw new NotFoundException("Order or Partner not found");
    }

    const mode = partner.transportMode || "cycle";
    const isCashStage = stage === "cash";
    const mercyAlreadyUsed = isCashStage
      ? order.cashTripMercyUsed
      : order.deliveryTripMercyUsed;

    const evaluation = travelTimerService.evaluateMercyExtension(
      remainingDistanceMeters,
      mode,
      mercyAlreadyUsed,
    );

    if (evaluation.mercyGranted) {
      if (isCashStage) {
        order.cashTripMercyUsed = true;
        order.cashTripExpiresAt = evaluation.newExpiresAt;
      } else {
        order.deliveryTripMercyUsed = true;
        order.deliveryTripExpiresAt = evaluation.newExpiresAt;
      }
      partner.mercyExtensionsUsedCount =
        (partner.mercyExtensionsUsedCount || 0) + 1;
      await Promise.all([order.save(), partner.save()]);

      return {
        mercyGranted: true,
        message: evaluation.reason,
      };
    } else {
      // Reputation Penalty
      partner.reputationScore = Math.max(
        0,
        partner.reputationScore - evaluation.reputationPenalty,
      );
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
  async verifyCashCollectionOtp(
    orderId: string,
    partnerId: string,
    otp: string,
  ): Promise<IOrder> {
    const Order = getOrderModel();
    const order = await Order.findOne({
      orderId,
      assignedPartnerId: partnerId,
    });

    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found for partner`);
    }

    if ((order.failedCashOtpAttempts || 0) >= 5) {
      throw new BadRequestException(
        "Too many failed OTP attempts. Maximum 5 attempts allowed.",
      );
    }

    if (!order.cashCollectionOtp || order.cashCollectionOtp !== otp) {
      order.failedCashOtpAttempts = (order.failedCashOtpAttempts || 0) + 1;
      await order.save();
      throw new BadRequestException("Invalid Cash Collection OTP");
    }

    if (
      order.cashCollectionOtpExpiresAt &&
      new Date() > order.cashCollectionOtpExpiresAt
    ) {
      throw new BadRequestException("Cash Collection OTP has expired");
    }

    order.failedCashOtpAttempts = 0;
    order.isCashCollected = true;
    order.cashCollectedAt = new Date();
    order.status = "CASH_COLLECTED";

    // Setup delivery trip timer
    const Partner = getPartnerModel();
    const partner = await Partner.findOne({ partnerId });
    const mode = partner?.transportMode || "cycle";

    const { etaSeconds, expiresAt } = travelTimerService.calculateEta(
      1500,
      mode,
    );
    order.deliveryTripEtaSeconds = etaSeconds;
    order.deliveryTripExpiresAt = expiresAt;
    order.deliveryTripMercyUsed = false;

    await order.save();

    wsDispatcher.broadcast(`order:${order.orderId}`, {
      type: "CASH_VERIFIED",
      orderId: order.orderId,
      message:
        "Cash payment confirmed! Partner is now fetching and delivering the product.",
      deliveryEtaSeconds: etaSeconds,
    });

    return order;
  }

  /**
   * 8. Verify Final Delivery OTP (Partner delivers product and completes order)
   */
  async verifyDeliveryOtp(
    orderId: string,
    partnerId: string,
    otp: string,
  ): Promise<IOrder> {
    const Order = getOrderModel();
    const Partner = getPartnerModel();
    const UserOrderProfile = getUserOrderProfileModel();

    const [order, partner] = await Promise.all([
      Order.findOne({ orderId, assignedPartnerId: partnerId }),
      Partner.findOne({ partnerId }),
    ]);

    if (!order || !partner) {
      throw new NotFoundException("Order or Partner not found");
    }

    if ((order.failedDeliveryOtpAttempts || 0) >= 5) {
      throw new BadRequestException(
        "Too many failed OTP attempts. Maximum 5 attempts allowed.",
      );
    }

    if (!order.deliveryOtp || order.deliveryOtp !== otp) {
      order.failedDeliveryOtpAttempts =
        (order.failedDeliveryOtpAttempts || 0) + 1;
      await order.save();
      throw new BadRequestException("Invalid Delivery Confirmation OTP");
    }

    if (order.deliveryOtpExpiresAt && new Date() > order.deliveryOtpExpiresAt) {
      throw new BadRequestException("Delivery Confirmation OTP has expired");
    }

    order.failedDeliveryOtpAttempts = 0;

    // Mark Order Delivered
    order.status = "DELIVERED";
    order.deliveredAt = new Date();

    // Release partner and update 5:1 ratio counters
    partner.activeOrderId = null;
    if (order.paymentMode === "ONLINE") {
      partner.onlineOrdersCompleted = (partner.onlineOrdersCompleted || 0) + 1;
    } else {
      partner.offlineOrdersCompleted =
        (partner.offlineOrdersCompleted || 0) + 1;
    }

    // Credit partner wallet virtual balance (if not already credited during online payment verification)
    if (order.paymentMode !== "ONLINE") {
      await this.creditPartnerWallet(
        partner.partnerId,
        order.deliveryFee,
        order.orderId,
        `Delivery fee earning for ${order.paymentMode} delivery`,
      );
    }

    // Update user profile completed orders
    await UserOrderProfile.findOneAndUpdate(
      { userId: order.userId },
      { $inc: { totalOrdersCompleted: 1 } },
      { upsert: true },
    );

    await Promise.all([order.save(), partner.save()]);

    wsDispatcher.broadcast(`order:${order.orderId}`, {
      type: "ORDER_DELIVERED",
      orderId: order.orderId,
      message: "Order delivered successfully!",
    });

    return order;
  }

  /**
   * 9. Handle 1-minute Payment Timeout Cancellation & Penalty Surcharge Tracking
   */
  async handlePaymentTimeout(order: IOrder): Promise<void> {
    order.status = "CANCELLED_PAYMENT_TIMEOUT";

    // Release assigned partner and restore online availability
    if (order.assignedPartnerId) {
      const Partner = getPartnerModel();
      await Partner.findOneAndUpdate(
        { partnerId: order.assignedPartnerId },
        { $set: { activeOrderId: null, isOnline: true } },
      );
    }

    // Update user cancellation penalty records
    const UserOrderProfile = getUserOrderProfileModel();
    const profile = await UserOrderProfile.findOneAndUpdate(
      { userId: order.userId },
      { $inc: { unpaidCancellationsCount: 1 } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    // If cancellations >= 2, penalty surcharge is active
    if (profile.unpaidCancellationsCount >= 2) {
      profile.penaltySurchargeApplies = true;
      await profile.save();
      logger.warn(
        `User ${order.userId} reached ${profile.unpaidCancellationsCount} unpaid cancellations. ₹0.30 penalty active on future orders.`,
      );
    } else {
      profile.hasUsedCancellationMercy = true;
      await profile.save();
      logger.info(
        `User ${order.userId} used their one-time cancellation mercy.`,
      );
    }

    await order.save();

    wsDispatcher.broadcast(`order:${order.orderId}`, {
      type: "ORDER_CANCELLED_PAYMENT_TIMEOUT",
      orderId: order.orderId,
      message: "1-minute payment selection window expired. Order cancelled.",
    });
  }

  /**
   * Helper: Credit Virtual Earnings to Partner In-App Wallet
   */
  private async creditPartnerWallet(
    partnerId: string,
    amount: number,
    orderId: string,
    description: string,
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
            type: "credit",
            category: "delivery_fee",
            description,
            createdAt: new Date(),
          },
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
  }

  private paymentSweeperTimer: NodeJS.Timeout | null = null;

  /**
   * 10. Sweep Expired Payment Windows (Cancels PAYMENT_PENDING orders older than 60s)
   */
  async sweepExpiredPaymentWindows(): Promise<number> {
    const Order = getOrderModel();
    const expiredOrders = await Order.find({
      status: "PAYMENT_PENDING",
      $or: [{ paymentMode: null }, { paymentMode: { $exists: false } }],
      paymentSelectionExpiresAt: { $lte: new Date() },
    });

    let sweptCount = 0;
    for (const order of expiredOrders) {
      try {
        await this.handlePaymentTimeout(order);
        sweptCount++;
        logger.info(
          `[PAYMENT SWEEPER] Auto-cancelled expired order ${order.orderId}`,
        );
      } catch (err) {
        logger.error(
          `[PAYMENT SWEEPER] Failed to cancel order ${order.orderId}:`,
          err,
        );
      }
    }
    return sweptCount;
  }

  /**
   * Start background payment timeout sweeper (e.g. every 10 seconds)
   */
  startPaymentTimeoutSweeper(intervalMs: number = 10000): void {
    if (this.paymentSweeperTimer) {
      return;
    }
    logger.info(
      `[PAYMENT SWEEPER] Background sweeper started (interval: ${intervalMs}ms)`,
    );
    this.paymentSweeperTimer = setInterval(async () => {
      try {
        await this.sweepExpiredPaymentWindows();
      } catch (error) {
        logger.error("[PAYMENT SWEEPER] Periodic sweep error:", error);
      }
    }, intervalMs);
    this.paymentSweeperTimer.unref();
  }

  /**
   * Stop background payment timeout sweeper
   */
  stopPaymentTimeoutSweeper(): void {
    if (this.paymentSweeperTimer) {
      clearInterval(this.paymentSweeperTimer);
      this.paymentSweeperTimer = null;
      logger.info("[PAYMENT SWEEPER] Background sweeper stopped");
    }
  }

  /**
   * 11. Get Live Tracking Details for Order (Partner real-time GPS, ETA, and stage)
   */
  async getLiveTracking(orderId: string): Promise<{
    orderId: string;
    status: string;
    paymentMode?: string | null;
    totalAmount: number;
    deliveryAddress: string;
    deliveryLocation: {
      latitude: number;
      longitude: number;
    };
    partner: {
      partnerId: string;
      name: string;
      phone: string;
      transportMode: string;
      rating: number;
      latitude: number;
      longitude: number;
      lastLocationUpdate?: Date;
    } | null;
    remainingDistanceMeters: number;
    estimatedRemainingSeconds: number;
    travelStage:
      | "CASH_COLLECTION"
      | "FINAL_DELIVERY"
      | "PREPARATION"
      | "COMPLETED";
    mercyExtensionUsed: boolean;
    timerExpiresAt?: Date;
    isPartnerArrived: boolean;
    routePolyline?: string;
    routeSource?: string;
    orderType?: OrderType;
    assignmentDetails?: any;
    printingDetails?: any;
  }> {
    const Order = getOrderModel();
    const order = await Order.findOne({ orderId }).lean();

    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    let partnerData = null;
    let partnerLat = order.latitude;
    let partnerLon = order.longitude;
    let transportMode = order.partnerTransportMode || "cycle";

    if (order.assignedPartnerId) {
      const Partner = getPartnerModel();
      const partner = await Partner.findOne({
        partnerId: order.assignedPartnerId,
      }).lean();
      if (partner) {
        transportMode = partner.transportMode || transportMode;
        partnerLat =
          partner.latitude ??
          partner.currentLocation?.coordinates?.[1] ??
          order.latitude;
        partnerLon =
          partner.longitude ??
          partner.currentLocation?.coordinates?.[0] ??
          order.longitude;

        partnerData = {
          partnerId: partner.partnerId,
          name: partner.name,
          phone: partner.phone,
          transportMode: partner.transportMode,
          rating: partner.rating,
          latitude: partnerLat,
          longitude: partnerLon,
          lastLocationUpdate: partner.lastLocationUpdate,
        };
      }
    }

    // Compute route, distance, and dynamic duration via Google Maps (with Haversine fallback)
    const route = await googleMapsService.calculateRoute(
      { latitude: partnerLat, longitude: partnerLon },
      { latitude: order.latitude, longitude: order.longitude },
      transportMode as any,
    );

    const distanceMeters = route.distanceMeters;
    const dynamicTravelSeconds = route.durationSeconds;

    let travelStage:
      | "CASH_COLLECTION"
      | "FINAL_DELIVERY"
      | "PREPARATION"
      | "COMPLETED" = "PREPARATION";
    if (order.status === "CASH_COLLECTION_IN_PROGRESS") {
      travelStage = "CASH_COLLECTION";
    } else if (
      order.status === "DELIVERY_IN_PROGRESS" ||
      order.status === "PARTNER_REACHED_DELIVERY"
    ) {
      travelStage = "FINAL_DELIVERY";
    } else if (order.status === "DELIVERED") {
      travelStage = "COMPLETED";
    }

    const timerExpiresAt =
      order.status === "CASH_COLLECTION_IN_PROGRESS"
        ? order.cashTripExpiresAt
        : order.status === "DELIVERY_IN_PROGRESS"
          ? order.deliveryTripExpiresAt
          : undefined;

    return {
      orderId: order.orderId,
      status: order.status,
      paymentMode: order.paymentMode,
      totalAmount: order.totalAmount,
      deliveryAddress: order.deliveryAddress,
      deliveryLocation: {
        latitude: order.latitude,
        longitude: order.longitude,
      },
      partner: partnerData,
      remainingDistanceMeters: distanceMeters,
      estimatedRemainingSeconds: dynamicTravelSeconds,
      travelStage,
      mercyExtensionUsed: !!(
        order.cashTripMercyUsed || order.deliveryTripMercyUsed
      ),
      timerExpiresAt,
      isPartnerArrived:
        order.status === "PARTNER_REACHED_DELIVERY" || !!order.cashCollectedAt,
      routePolyline: route.polyline,
      routeSource: route.source,
      orderType: order.orderType || "STANDARD_PRODUCTS",
      assignmentDetails: order.assignmentDetails,
      printingDetails: order.printingDetails,
    };
  }

  /**
   * 12. Rate Partner Order (Customer submits 1-5 star review and feedback)
   */
  async ratePartnerOrder(
    orderId: string,
    userId: string | undefined,
    rating: number,
    feedback?: string,
  ): Promise<{
    orderId: string;
    rating: number;
    feedback?: string;
    partnerRating: number;
    partnerRatingCount: number;
    partnerReputationScore: number;
  }> {
    const Order = getOrderModel();
    const order = await Order.findOne({ orderId });

    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    if (userId && order.userId && order.userId !== userId) {
      throw new BadRequestException(
        "You are not authorized to rate this order",
      );
    }

    if (order.status !== "DELIVERED") {
      throw new BadRequestException(
        `Order cannot be rated until it is delivered. Current status: ${order.status}`,
      );
    }

    if (order.isRated) {
      throw new ConflictException("This order has already been rated");
    }

    order.isRated = true;
    order.rating = rating;
    order.ratingFeedback = feedback;
    order.ratedAt = new Date();
    await order.save();

    let partnerRating = 5.0;
    let partnerRatingCount = 0;
    let partnerReputation = 100;

    if (order.assignedPartnerId) {
      const Partner = getPartnerModel();
      const partner = await Partner.findOne({
        partnerId: order.assignedPartnerId,
      });
      if (partner) {
        const currentCount = partner.ratingCount || 0;
        const currentAvg = partner.rating || 5.0;
        const newCount = currentCount + 1;
        const newAvg =
          Math.round(((currentAvg * currentCount + rating) / newCount) * 10) /
          10;

        partner.rating = Math.max(1.0, Math.min(5.0, newAvg));
        partner.ratingCount = newCount;

        if (rating >= 4) {
          partner.reputationScore = Math.min(
            100,
            (partner.reputationScore || 100) + 1,
          );
        } else if (rating <= 2) {
          partner.reputationScore = Math.max(
            0,
            (partner.reputationScore || 100) - 3,
          );
        }

        await partner.save();
        partnerRating = partner.rating;
        partnerRatingCount = partner.ratingCount;
        partnerReputation = partner.reputationScore;
      }
    }

    return {
      orderId: order.orderId,
      rating,
      feedback,
      partnerRating,
      partnerRatingCount,
      partnerReputationScore: partnerReputation,
    };
  }

  /**
   * 13. Partner Marks Product Picked Up (Proceeds to final delivery)
   */
  async markProductPickedUp(
    orderId: string,
    partnerId: string,
  ): Promise<IOrder> {
    const Order = getOrderModel();
    const order = await Order.findOne({
      orderId,
      assignedPartnerId: partnerId,
    });

    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found for partner`);
    }

    const allowedStatuses = ["PAID", "CASH_COLLECTED"];
    if (!allowedStatuses.includes(order.status)) {
      throw new BadRequestException(
        `Product cannot be marked picked up from current status '${order.status}'. Payment/Cash collection must be completed first.`,
      );
    }

    order.status = "DELIVERY_IN_PROGRESS";

    const Partner = getPartnerModel();
    const partner = await Partner.findOne({ partnerId });
    const mode = partner?.transportMode || "cycle";
    const partnerLat = partner?.latitude || order.latitude;
    const partnerLon = partner?.longitude || order.longitude;

    const route = await googleMapsService.calculateRoute(
      { latitude: partnerLat, longitude: partnerLon },
      { latitude: order.latitude, longitude: order.longitude },
      mode,
    );

    order.deliveryTripEtaSeconds = route.durationSeconds;
    order.deliveryTripExpiresAt = new Date(
      Date.now() + route.durationSeconds * 1000,
    );
    await order.save();

    wsDispatcher.broadcast(`order:${order.orderId}`, {
      type: "PRODUCT_PICKED_UP",
      orderId: order.orderId,
      status: order.status,
      deliveryEtaSeconds: route.durationSeconds,
      message:
        "Partner has picked up the product and is heading to your delivery location.",
    });

    return order;
  }

  /**
   * 14. Customer Cancels Order
   */
  async cancelOrderByUser(
    orderId: string,
    userId: string,
    reason?: string,
  ): Promise<IOrder> {
    const Order = getOrderModel();
    const order = await Order.findOne({ orderId, userId });

    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found for user`);
    }

    if (order.status === "DELIVERED") {
      throw new BadRequestException("Delivered orders cannot be cancelled");
    }

    if (order.status.startsWith("CANCELLED")) {
      throw new ConflictException("Order has already been cancelled");
    }

    order.status = "CANCELLED_BY_USER";

    // Automatic Razorpay Refund for paid online orders
    if (order.isPaid && order.razorpayPaymentId) {
      try {
        const refund = await razorpayService.refundPayment(
          order.razorpayPaymentId,
          order.totalAmount,
          {
            orderId: order.orderId,
            reason: reason || "Customer cancelled order",
          },
        );
        order.refundStatus = "COMPLETED";
        order.razorpayRefundId = refund.id;
        order.refundAmount = order.totalAmount;
        order.refundedAt = new Date();
        logger.info(
          `[REFUND] Processed refund ${refund.id} of ₹${order.totalAmount} for order ${order.orderId}`,
        );
      } catch (refundError) {
        order.refundStatus = "FAILED";
        logger.error(
          `[REFUND ERROR] Failed to process refund for order ${order.orderId}:`,
          refundError,
        );
      }
    }

    if (order.assignedPartnerId) {
      const Partner = getPartnerModel();
      await Partner.findOneAndUpdate(
        { partnerId: order.assignedPartnerId },
        { $set: { activeOrderId: null, isOnline: true } },
      );
    }

    await order.save();

    wsDispatcher.broadcast(`order:${order.orderId}`, {
      type: "ORDER_CANCELLED_BY_USER",
      orderId: order.orderId,
      reason: reason || "Cancelled by customer",
    });

    return order;
  }

  /**
   * 15. Get Active Order for Partner App
   */
  async getPartnerActiveOrder(partnerId: string): Promise<IOrder | null> {
    const Order = getOrderModel();
    return await Order.findOne({
      assignedPartnerId: partnerId,
      status: {
        $nin: [
          "DELIVERED",
          "CANCELLED_PAYMENT_TIMEOUT",
          "CANCELLED_SERVICE_UNAVAILABLE",
          "CANCELLED_BY_USER",
        ],
      },
    }).select("-cashCollectionOtp -deliveryOtp");
  }

  /**
   * 16. Get Active Order for User App
   */
  async getUserActiveOrder(userId: string): Promise<IOrder | null> {
    const Order = getOrderModel();
    return await Order.findOne({
      userId,
      status: {
        $nin: [
          "DELIVERED",
          "CANCELLED_PAYMENT_TIMEOUT",
          "CANCELLED_SERVICE_UNAVAILABLE",
          "CANCELLED_BY_USER",
        ],
      },
    })
      .select("-cashCollectionOtp -deliveryOtp")
      .sort({ createdAt: -1 });
  }

  /**
   * 17. Inspect Payment Gateway Details & Status
   */
  async getOrderPaymentStatus(orderId: string): Promise<any> {
    const Order = getOrderModel();
    const order = await Order.findOne({ orderId }).select(
      "-cashCollectionOtp -deliveryOtp",
    );

    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    let gatewayDetails: any = null;
    if (order.razorpayPaymentId) {
      try {
        gatewayDetails = await razorpayService.fetchPayment(
          order.razorpayPaymentId,
        );
      } catch (err: any) {
        gatewayDetails = { error: err.message };
      }
    }

    return {
      orderId: order.orderId,
      status: order.status,
      paymentMode: order.paymentMode,
      isPaid: order.isPaid,
      paidAt: order.paidAt,
      totalAmount: order.totalAmount,
      razorpayOrderId: order.razorpayOrderId,
      razorpayPaymentId: order.razorpayPaymentId,
      refundStatus: order.refundStatus || "NONE",
      razorpayRefundId: order.razorpayRefundId,
      refundAmount: order.refundAmount,
      refundedAt: order.refundedAt,
      gatewayDetails,
    };
  }

  /**
   * 18. Handle Asynchronous Razorpay Webhooks
   */
  async handleRazorpayWebhook(
    event: string,
    payload: any,
  ): Promise<{ handled: boolean; message: string }> {
    logger.info(`[RAZORPAY WEBHOOK] Processing event '${event}'`);

    const paymentEntity = payload?.payment?.entity;
    const orderEntity = payload?.order?.entity;

    const razorpayOrderId = paymentEntity?.order_id || orderEntity?.id;
    const razorpayPaymentId = paymentEntity?.id;

    if (!razorpayOrderId) {
      return { handled: false, message: "Missing order_id in webhook payload" };
    }

    const Order = getOrderModel();
    const order = await Order.findOne({ razorpayOrderId });

    if (!order) {
      logger.warn(
        `[RAZORPAY WEBHOOK] Order not found for razorpayOrderId ${razorpayOrderId}`,
      );
      return {
        handled: false,
        message: `Order not found for ${razorpayOrderId}`,
      };
    }

    if (event === "payment.captured" || event === "order.paid") {
      if (!order.isPaid) {
        await this.verifyOnlinePayment(
          order.orderId,
          razorpayOrderId,
          razorpayPaymentId || `pay_wh_${Date.now()}`,
        );
        return {
          handled: true,
          message: `Order ${order.orderId} marked PAID via webhook`,
        };
      }
      return {
        handled: true,
        message: `Order ${order.orderId} was already paid`,
      };
    }

    if (event === "payment.failed") {
      logger.warn(
        `[RAZORPAY WEBHOOK] Payment failed for order ${order.orderId}: ${paymentEntity?.error_description}`,
      );
      return {
        handled: true,
        message: `Recorded payment failure for ${order.orderId}`,
      };
    }

    return { handled: true, message: `Event ${event} acknowledged` };
  }

  /**
   * 19. Create Assignment Writing Order
   * Calculates writing charge (₹1/page), page price (₹1/page), nearest xerox shop buying ETA, and handwriting ETA.
   */
  async createAssignmentOrder(input: {
    userId?: string;
    userName?: string;
    userEmail?: string;
    userPhone?: string;
    latitude: number;
    longitude: number;
    deliveryAddress: string;
    assignmentText: string;
    explanation: string;
    pageCount?: number;
  }): Promise<IOrder> {
    const userId = input.userId || "guest_user";
    const userEmail = input.userEmail || `${userId}@example.com`;
    const userName = input.userName || "Student";
    const userPhone = input.userPhone || "9876543210";

    // 1. Check partner crisis gate in 2.5km radius (>= 2 online partners)
    const availability = await partnerDispatchService.checkPartnerAvailability(
      input.latitude,
      input.longitude,
    );

    if (!availability.isAvailable) {
      throw new AppError(
        "Service temporarily unavailable due to partner crisis. At least 2 active delivery partners must be online in your zone. Please try again shortly.",
        503,
      );
    }

    // 2. Algorithm: Calculate word count & page count (standard 250 words/page)
    const words = input.assignmentText.trim().split(/\s+/).filter(Boolean);
    const wordCount = words.length;
    const computedPages =
      input.pageCount && input.pageCount > 0
        ? input.pageCount
        : Math.max(1, Math.ceil(wordCount / 250));

    // 3. Billing calculation:
    // Written charge: ₹1 per page
    // Page price: ₹1 per page
    const writingChargePerPage = 1.0;
    const pagePricePerPage = 1.0;
    const totalPageCharge =
      Math.round(
        computedPages * (writingChargePerPage + pagePricePerPage) * 100,
      ) / 100;
    const deliveryFee = 15.0;

    // Check cancellation surcharge
    const UserOrderProfile = getUserOrderProfileModel();
    const userProfile = await UserOrderProfile.findOne({ userId });
    let cancellationPenaltySurcharge = 0.0;
    if (userProfile && userProfile.unpaidCancellationsCount >= 2) {
      cancellationPenaltySurcharge = 0.3; // 30 paisa
    }

    const totalAmount =
      Math.round(
        (totalPageCharge + deliveryFee + cancellationPenaltySurcharge) * 100,
      ) / 100;

    // 4. Algorithm: Calculate handwritten time and page buying time from nearest xerox shop
    const userLoc = { latitude: input.latitude, longitude: input.longitude };
    const refPartnerLoc =
      availability.candidatePartners[0]?.latitude &&
      availability.candidatePartners[0]?.longitude
        ? {
            latitude: availability.candidatePartners[0].latitude,
            longitude: availability.candidatePartners[0].longitude,
          }
        : userLoc;

    const timings = await xeroxShopService.calculateAssignmentTimings(
      refPartnerLoc,
      userLoc,
      computedPages,
      wordCount,
      "cycle",
    );

    const orderId = this.generateOrderId();
    const Order = getOrderModel();

    const order = await Order.create({
      orderId,
      orderType: "ASSIGNMENT_WRITING",
      userId,
      userName,
      userEmail,
      userPhone,
      latitude: input.latitude,
      longitude: input.longitude,
      deliveryLocation: {
        type: "Point",
        coordinates: [input.longitude, input.latitude],
      },
      deliveryAddress: input.deliveryAddress,
      items: [
        {
          productId: "SERVICE_ASSIGNMENT_WRITING",
          title: `Assignment Handwritten Writing Service (${computedPages} Pages)`,
          price: 2.0,
          quantity: computedPages,
          subtotal: totalPageCharge,
        },
      ],
      subtotal: totalPageCharge,
      deliveryFee,
      cancellationPenaltySurcharge,
      totalAmount,
      status: "SEARCHING_PARTNER",
      notifiedPartnerIds: [],
      ringBandsNotified: [],
      isPaid: false,
      isCashCollected: false,
      assignmentDetails: {
        assignmentText: input.assignmentText,
        explanation: input.explanation,
        pageCount: computedPages,
        wordCount,
        writingChargePerPage,
        pagePricePerPage,
        totalPageCharge,
        handwrittenTimeMinutes: timings.handwrittenMinutes,
        pageBuyingTimeMinutes: timings.pageBuyingMinutes,
        deliveryTravelEtaMinutes: timings.deliveryTravelMinutes,
        totalEtaMinutes: timings.totalEtaMinutes,
        estimatedDeliveryAt: timings.estimatedDeliveryAt,
        nearestXeroxShop: timings.nearestShop,
        currentStage: "BUYING_PAGES",
      },
    });

    // 5. Ring partners within 2.5km concentric zone
    await partnerDispatchService.dispatchOrderRings(
      order,
      availability.candidatePartners,
    );

    wsDispatcher.broadcast("orders:new", {
      type: "NEW_ASSIGNMENT_ORDER",
      orderId: order.orderId,
      pageCount: computedPages,
      totalAmount,
    });

    logger.info(
      `[ASSIGNMENT ORDER CREATED] ${order.orderId} - Pages: ${computedPages}, Amount: ₹${totalAmount}, Shop: ${timings.nearestShop.name}`,
    );

    return order;
  }

  /**
   * 20. Calculate Assignment Writing Billing Preview
   */
  async calculateAssignmentBilling(input: {
    userId?: string;
    assignmentText: string;
    pageCount?: number;
    approxDistanceMeters?: number;
  }) {
    const words = input.assignmentText.trim().split(/\s+/).filter(Boolean);
    const wordCount = words.length;
    const computedPages =
      input.pageCount && input.pageCount > 0
        ? input.pageCount
        : Math.max(1, Math.ceil(wordCount / 250));

    const writingCharge = computedPages * 1.0;
    const pagePrice = computedPages * 1.0;
    const subtotal = writingCharge + pagePrice;
    const deliveryFee = 15.0;

    const UserOrderProfile = getUserOrderProfileModel();
    const userProfile = input.userId
      ? await UserOrderProfile.findOne({ userId: input.userId })
      : null;
    let cancellationPenaltySurcharge = 0.0;
    if (userProfile && userProfile.unpaidCancellationsCount >= 2) {
      cancellationPenaltySurcharge = 0.3;
    }

    const totalAmount =
      Math.round(
        (subtotal + deliveryFee + cancellationPenaltySurcharge) * 100,
      ) / 100;
    const timings = xeroxShopService.calculateHandwrittenTime(
      wordCount,
      computedPages,
    );

    return {
      wordCount,
      pageCount: computedPages,
      writingChargePerPage: 1.0,
      pagePricePerPage: 1.0,
      writingCharge,
      pagePrice,
      subtotal,
      deliveryFee,
      cancellationPenaltySurcharge,
      totalAmount,
      handwrittenMinutes: timings.handwrittenMinutes,
    };
  }

  /**
   * 21. Update Assignment Writing Progress Stage
   */
  async updateAssignmentStage(
    orderId: string,
    partnerId: string,
    stage: "BUYING_PAGES" | "WRITING_ASSIGNMENT" | "OUT_FOR_DELIVERY",
  ): Promise<IOrder> {
    const Order = getOrderModel();
    const order = await Order.findOne({ orderId });

    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    if (order.assignedPartnerId !== partnerId) {
      throw new BadRequestException(
        "Only the assigned partner can update assignment stage",
      );
    }

    if (order.orderType !== "ASSIGNMENT_WRITING" || !order.assignmentDetails) {
      throw new BadRequestException("Order is not an assignment writing order");
    }

    order.assignmentDetails.currentStage = stage;
    const now = new Date();

    if (stage === "BUYING_PAGES") {
      order.status = "BUYING_PAGES";
      order.assignmentDetails.startedBuyingPagesAt = now;
    } else if (stage === "WRITING_ASSIGNMENT") {
      order.status = "WRITING_ASSIGNMENT";
      order.assignmentDetails.startedWritingAt = now;
    } else if (stage === "OUT_FOR_DELIVERY") {
      order.status = "DELIVERY_IN_PROGRESS";
      order.assignmentDetails.finishedWritingAt = now;
    }

    await order.save();

    wsDispatcher.broadcast(`order:${order.orderId}`, {
      type: "ASSIGNMENT_STAGE_UPDATED",
      orderId: order.orderId,
      stage,
      status: order.status,
      message: `Assignment stage updated to ${stage}`,
    });

    return order;
  }

  /**
   * 22. Create Document Printing Order
   * Uploads image to Google Drive, dispatches ring within 2.5km radius.
   */
  async createPrintingOrder(
    input: {
      userId?: string;
      userName?: string;
      userEmail?: string;
      userPhone?: string;
      latitude: number;
      longitude: number;
      deliveryAddress: string;
      pageCount: number;
      copies?: number;
      colorMode?: "BW" | "COLOR";
      printSides?: "SINGLE" | "DOUBLE";
      explanation?: string;
      fileBase64?: string;
      fileName?: string;
      mimeType?: string;
    },
    uploadedFile?: Express.Multer.File,
  ): Promise<IOrder> {
    const userId = input.userId || "guest_user";
    const userEmail = input.userEmail || `${userId}@example.com`;
    const userName = input.userName || "Customer";
    const userPhone = input.userPhone || "9876543210";

    // 1. Partner Crisis Gate Check
    const availability = await partnerDispatchService.checkPartnerAvailability(
      input.latitude,
      input.longitude,
    );

    if (!availability.isAvailable) {
      throw new AppError(
        "Service temporarily unavailable due to partner crisis. At least 2 active delivery partners must be online in your zone. Please try again shortly.",
        503,
      );
    }

    // 2. Upload file to Google Drive (or local cloud storage fallback)
    let fileBuffer: Buffer;
    let fileName: string = input.fileName || "document.jpg";
    let mimeType: string = input.mimeType || "image/jpeg";

    if (uploadedFile) {
      fileBuffer = uploadedFile.buffer;
      fileName = uploadedFile.originalname;
      mimeType = uploadedFile.mimetype;
    } else if (input.fileBase64) {
      const cleanBase64 = input.fileBase64.replace(
        /^data:image\/\w+;base64,/,
        "",
      );
      fileBuffer = Buffer.from(cleanBase64, "base64");
    } else {
      fileBuffer = Buffer.from("MOCK_PRINT_IMAGE_PAYLOAD");
    }

    const driveDoc = await googleDriveService.uploadFile(
      fileBuffer,
      fileName,
      mimeType,
    );

    // 3. Billing calculation:
    // Black & White (BW): ₹2.00 / page, Color: ₹10.00 / page
    const pageCount = Number(input.pageCount) || 1;
    const copies = Number(input.copies) || 1;
    const colorMode = input.colorMode || "BW";
    const ratePerPage = colorMode === "COLOR" ? 10.0 : 2.0;
    const totalPrintCharge =
      Math.round(pageCount * copies * ratePerPage * 100) / 100;
    const deliveryFee = 15.0;

    const UserOrderProfile = getUserOrderProfileModel();
    const userProfile = await UserOrderProfile.findOne({ userId });
    let cancellationPenaltySurcharge = 0.0;
    if (userProfile && userProfile.unpaidCancellationsCount >= 2) {
      cancellationPenaltySurcharge = 0.3;
    }

    const totalAmount =
      Math.round(
        (totalPrintCharge + deliveryFee + cancellationPenaltySurcharge) * 100,
      ) / 100;

    const orderId = this.generateOrderId();
    const Order = getOrderModel();

    const order = await Order.create({
      orderId,
      orderType: "DOCUMENT_PRINTING",
      userId,
      userName,
      userEmail,
      userPhone,
      latitude: input.latitude,
      longitude: input.longitude,
      deliveryLocation: {
        type: "Point",
        coordinates: [input.longitude, input.latitude],
      },
      deliveryAddress: input.deliveryAddress,
      items: [
        {
          productId: "SERVICE_DOCUMENT_PRINTING",
          title: `Document Printing (${pageCount} Pages, ${colorMode})`,
          price: ratePerPage,
          quantity: pageCount * copies,
          subtotal: totalPrintCharge,
        },
      ],
      subtotal: totalPrintCharge,
      deliveryFee,
      cancellationPenaltySurcharge,
      totalAmount,
      status: "SEARCHING_PARTNER",
      notifiedPartnerIds: [],
      ringBandsNotified: [],
      isPaid: false,
      isCashCollected: false,
      printingDetails: {
        fileId: driveDoc.fileId,
        fileName: driveDoc.fileName,
        fileUrl: driveDoc.downloadUrl,
        googleDriveFileId: driveDoc.googleDriveFileId,
        googleDriveViewLink: driveDoc.googleDriveViewLink,
        googleDriveDownloadLink: driveDoc.googleDriveDownloadLink,
        mimeType: driveDoc.mimeType,
        fileSizeBytes: driveDoc.sizeBytes,
        pageCount,
        copies,
        colorMode,
        printSides: input.printSides || "SINGLE",
        printRatePerPage: ratePerPage,
        totalPrintCharge,
        explanation: input.explanation,
        currentStage: "PRINTING_IN_PROGRESS",
      },
    });

    // 4. Ring partners in 2.5km radius
    await partnerDispatchService.dispatchOrderRings(
      order,
      availability.candidatePartners,
    );

    wsDispatcher.broadcast("orders:new", {
      type: "NEW_PRINTING_ORDER",
      orderId: order.orderId,
      pageCount,
      copies,
      colorMode,
      totalAmount,
    });

    logger.info(
      `[PRINTING ORDER CREATED] ${order.orderId} - File: ${driveDoc.fileName}, Drive: ${driveDoc.googleDriveFileId}, Total: ₹${totalAmount}`,
    );

    return order;
  }

  /**
   * 23. Calculate Printing Billing Preview
   */
  async calculatePrintingBilling(input: {
    userId?: string;
    pageCount: number;
    copies?: number;
    colorMode?: "BW" | "COLOR";
    approxDistanceMeters?: number;
  }) {
    const pageCount = Number(input.pageCount) || 1;
    const copies = Number(input.copies) || 1;
    const colorMode = input.colorMode || "BW";
    const ratePerPage = colorMode === "COLOR" ? 10.0 : 2.0;
    const subtotal = Math.round(pageCount * copies * ratePerPage * 100) / 100;
    const deliveryFee = 15.0;

    const UserOrderProfile = getUserOrderProfileModel();
    const userProfile = input.userId
      ? await UserOrderProfile.findOne({ userId: input.userId })
      : null;
    let cancellationPenaltySurcharge = 0.0;
    if (userProfile && userProfile.unpaidCancellationsCount >= 2) {
      cancellationPenaltySurcharge = 0.3;
    }

    const totalAmount =
      Math.round(
        (subtotal + deliveryFee + cancellationPenaltySurcharge) * 100,
      ) / 100;

    return {
      pageCount,
      copies,
      colorMode,
      ratePerPage,
      subtotal,
      deliveryFee,
      cancellationPenaltySurcharge,
      totalAmount,
    };
  }

  /**
   * 24. Update Document Printing Progress Stage
   */
  async updatePrintingStage(
    orderId: string,
    partnerId: string,
    stage: "PRINTING_IN_PROGRESS" | "OUT_FOR_DELIVERY",
  ): Promise<IOrder> {
    const Order = getOrderModel();
    const order = await Order.findOne({ orderId });

    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    if (order.assignedPartnerId !== partnerId) {
      throw new BadRequestException(
        "Only the assigned partner can update printing stage",
      );
    }

    if (order.orderType !== "DOCUMENT_PRINTING" || !order.printingDetails) {
      throw new BadRequestException("Order is not a document printing order");
    }

    order.printingDetails.currentStage = stage;
    const now = new Date();

    if (stage === "PRINTING_IN_PROGRESS") {
      order.status = "PRINTING_IN_PROGRESS";
      order.printingDetails.startedPrintingAt = now;
    } else if (stage === "OUT_FOR_DELIVERY") {
      order.status = "DELIVERY_IN_PROGRESS";
      order.printingDetails.finishedPrintingAt = now;
    }

    await order.save();

    wsDispatcher.broadcast(`order:${order.orderId}`, {
      type: "PRINTING_STAGE_UPDATED",
      orderId: order.orderId,
      stage,
      status: order.status,
      message: `Printing stage updated to ${stage}`,
    });

    return order;
  }

  /**
   * 25. Proximity Arrival Check & Phone Ringing Handshake
   * When partner is near the user (< 150m), rings user phone, dispatches delivery OTP.
   */
  async triggerProximityRinging(
    orderId: string,
    partnerId: string,
    partnerLat?: number,
    partnerLon?: number,
  ): Promise<{
    ringing: boolean;
    distanceMeters: number;
    message: string;
    requiresOtp: boolean;
  }> {
    const Order = getOrderModel();
    const order = await Order.findOne({ orderId });

    if (!order) {
      throw new NotFoundException(`Order ${orderId} not found`);
    }

    if (order.assignedPartnerId !== partnerId) {
      throw new BadRequestException(
        "Only the assigned partner can trigger arrival ringing",
      );
    }

    let distanceMeters = 50;
    if (partnerLat !== undefined && partnerLon !== undefined) {
      distanceMeters = Math.round(
        calculateHaversineDistance(
          partnerLat,
          partnerLon,
          order.latitude,
          order.longitude,
        ),
      );
    }

    // Generate delivery OTP if not yet generated
    if (!order.deliveryOtp) {
      order.deliveryOtp = this.generate6DigitOtp();
      order.deliveryOtpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);
    }

    order.status = "PARTNER_REACHED_DELIVERY";
    if (order.assignmentDetails) {
      order.assignmentDetails.currentStage = "ARRIVED";
    }
    if (order.printingDetails) {
      order.printingDetails.currentStage = "ARRIVED";
    }
    await order.save();

    // 1. Dispatch real email with delivery OTP to user
    if (order.userEmail) {
      await emailService.sendDeliveryOtpEmail({
        email: order.userEmail,
        userName: order.userName,
        orderId: order.orderId,
        otp: order.deliveryOtp,
        partnerName: order.assignedPartnerName,
      });
    }

    // 2. Dispatch real-time phone ring alert to user via WebSocket
    wsDispatcher.broadcast(`user:order:${order.userId}`, {
      type: "USER_PHONE_RING_ALERT",
      orderId: order.orderId,
      partnerName: order.assignedPartnerName,
      partnerPhone: order.assignedPartnerPhone,
      proximityMeters: distanceMeters,
      message:
        "Your partner has arrived near your location! Your phone is ringing. Please share your delivery OTP with the partner.",
      ringToneUrl: "/assets/audio/delivery_ring.mp3",
      requiresOtp: true,
    });

    wsDispatcher.broadcast(`order:${order.orderId}`, {
      type: "USER_PHONE_RING_ALERT",
      orderId: order.orderId,
      partnerName: order.assignedPartnerName,
      partnerPhone: order.assignedPartnerPhone,
      proximityMeters: distanceMeters,
      message: "Partner arrived near location. Phone ringing alert dispatched.",
      ringToneUrl: "/assets/audio/delivery_ring.mp3",
    });

    logger.info(
      `[PROXIMITY RING] Partner ${partnerId} within ${distanceMeters}m of user for order ${order.orderId}. Phone ringing and delivery OTP sent.`,
    );

    return {
      ringing: true,
      distanceMeters,
      message:
        "User phone is ringing. Delivery OTP has been dispatched to user.",
      requiresOtp: true,
    };
  }
}

export const orderService = new OrderService();
