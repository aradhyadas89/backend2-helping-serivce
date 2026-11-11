import { getPartnerModel, IPartner } from '../models/Partner';
import { getOrderModel, IOrder } from '../models/Order';
import { calculateHaversineDistance } from '../utils/geo.utils';
import { wsDispatcher } from '../websocket/ws-dispatcher';
import { logger } from '../config/logger';
import { ConflictException } from '../middlewares/errorHandler';

export interface RingPartitionBox {
  boxIndex: number;
  minDistanceMeters: number;
  maxDistanceMeters: number;
  delaySeconds: number;
  partners: Array<{
    partner: IPartner;
    distanceMeters: number;
  }>;
}

export class PartnerDispatchService {
  public readonly DISPATCH_MAX_RADIUS_METERS = 2500; // 2.5 km
  public readonly MIN_REQUIRED_ONLINE_PARTNERS = 2; // Crisis gate threshold

  // 4 Concentric Distance Bands / Boxes
  public readonly RING_BANDS = [
    { boxIndex: 1, minDistance: 0, maxDistance: 500, delaySeconds: 0 },
    { boxIndex: 2, minDistance: 500, maxDistance: 1000, delaySeconds: 5 },
    { boxIndex: 3, minDistance: 1000, maxDistance: 1750, delaySeconds: 10 },
    { boxIndex: 4, minDistance: 1750, maxDistance: 2500, delaySeconds: 15 },
  ];

  /**
   * Check if at least 2 online partners are available in the 2.5km dispatch zone (Partner Crisis Gate)
   */
  async checkPartnerAvailability(
    userLat: number,
    userLon: number
  ): Promise<{ isAvailable: boolean; availableCount: number; candidatePartners: IPartner[] }> {
    const Partner = getPartnerModel();

    // Fetch all unblocked online partners without active orders
    const onlinePartners = await Partner.find({
      isOnline: true,
      isBlocked: false,
      activeOrderId: null,
    });

    const candidatePartners: IPartner[] = [];

    for (const p of onlinePartners) {
      if (p.latitude !== undefined && p.longitude !== undefined) {
        const dist = calculateHaversineDistance(userLat, userLon, p.latitude, p.longitude);
        if (dist <= this.DISPATCH_MAX_RADIUS_METERS) {
          candidatePartners.push(p);
        }
      } else {
        // Fallback for mock/test data if coordinates are directly on profile
        candidatePartners.push(p);
      }
    }

    const availableCount = candidatePartners.length;
    const isAvailable = availableCount >= this.MIN_REQUIRED_ONLINE_PARTNERS;

    return {
      isAvailable,
      availableCount,
      candidatePartners,
    };
  }

  /**
   * Partition candidate partners into 2.5km concentric ring boxes and trigger staggered ringing
   */
  async dispatchOrderRings(order: IOrder, candidatePartners: IPartner[]): Promise<void> {
    const boxes: RingPartitionBox[] = this.RING_BANDS.map((b) => ({
      boxIndex: b.boxIndex,
      minDistanceMeters: b.minDistance,
      maxDistanceMeters: b.maxDistance,
      delaySeconds: b.delaySeconds,
      partners: [],
    }));

    for (const partner of candidatePartners) {
      const lat = partner.latitude || order.latitude;
      const lon = partner.longitude || order.longitude;
      const distanceMeters = Math.round(
        calculateHaversineDistance(order.latitude, order.longitude, lat, lon)
      );

      for (const box of boxes) {
        if (
          distanceMeters >= box.minDistanceMeters &&
          distanceMeters <= box.maxDistanceMeters
        ) {
          box.partners.push({ partner, distanceMeters });
          break;
        }
      }
    }

    // Schedule delayed ringing per box
    for (const box of boxes) {
      if (box.partners.length === 0) continue;

      const notifyPartners = () => {
        for (const { partner, distanceMeters } of box.partners) {
          logger.info(
            `[RING DISPATCH] Order ${order.orderId} ringing Partner ${partner.partnerId} (${partner.name}) in Box ${box.boxIndex} (${distanceMeters}m away, delay ${box.delaySeconds}s)`
          );

          // Broadcast phone ringing event to partner
          wsDispatcher.broadcast(`partner:ring:${partner.partnerId}`, {
            type: 'ORDER_RINGING',
            orderId: order.orderId,
            userLocation: { latitude: order.latitude, longitude: order.longitude },
            deliveryAddress: order.deliveryAddress,
            subtotal: order.subtotal,
            totalAmount: order.totalAmount,
            distanceMeters,
            boxIndex: box.boxIndex,
            timestamp: new Date().toISOString(),
          });
        }
      };

      if (box.delaySeconds === 0) {
        notifyPartners();
      } else {
        setTimeout(notifyPartners, box.delaySeconds * 1000);
      }
    }
  }

  /**
   * Atomic Order Acceptance (First-Pick Race Protection)
   */
  async atomicAcceptOrder(orderId: string, partnerId: string): Promise<IOrder> {
    const Partner = getPartnerModel();
    const Order = getOrderModel();

    const partner = await Partner.findOne({ partnerId, isOnline: true, isBlocked: false });
    if (!partner) {
      throw new ConflictException('Partner is not currently active, online, or authorized');
    }

    if (partner.activeOrderId) {
      throw new ConflictException('Partner already has an active ongoing delivery order');
    }

    const now = new Date();
    const paymentDeadline = new Date(now.getTime() + 60 * 1000); // 1-minute window

    // Atomic MongoDB transition from SEARCHING_PARTNER to PAYMENT_PENDING
    const acceptedOrder = await Order.findOneAndUpdate(
      {
        orderId,
        status: 'SEARCHING_PARTNER',
        assignedPartnerId: null,
      },
      {
        $set: {
          assignedPartnerId: partner.partnerId,
          assignedPartnerName: partner.name,
          assignedPartnerPhone: partner.phone,
          partnerTransportMode: partner.transportMode,
          partnerAcceptedAt: now,
          status: 'PAYMENT_PENDING',
          paymentSelectionExpiresAt: paymentDeadline,
        },
      },
      { new: true }
    );

    if (!acceptedOrder) {
      throw new ConflictException('Order has already been picked up by another partner or has expired');
    }

    // Assign active order to partner
    partner.activeOrderId = orderId;
    await partner.save();

    logger.info(`[ORDER CLAIMED] Order ${orderId} successfully assigned to Partner ${partner.partnerId} (${partner.name})`);

    // Broadcast to user that partner was found and 1-minute payment countdown started
    wsDispatcher.broadcast(`user:order:${acceptedOrder.userId}`, {
      type: 'PARTNER_ASSIGNED',
      orderId: acceptedOrder.orderId,
      partner: {
        id: partner.partnerId,
        name: partner.name,
        phone: partner.phone,
        transportMode: partner.transportMode,
        rating: partner.rating,
      },
      paymentSelectionExpiresAt: paymentDeadline.toISOString(),
      timeRemainingSeconds: 60,
    });

    return acceptedOrder;
  }

  /**
   * Verify Partner 5:1 Online-to-Offline Payment Mode Ratio Balancer
   * Ratio requirement: 5 online orders per 1 offline order
   */
  async checkPartnerOfflineRatioEligibility(partnerId: string): Promise<{
    isEligible: boolean;
    onlineCompleted: number;
    offlineCompleted: number;
    maxOfflineAllowed: number;
    reason?: string;
  }> {
    const Partner = getPartnerModel();
    const partner = await Partner.findOne({ partnerId });

    if (!partner) {
      return { isEligible: true, onlineCompleted: 0, offlineCompleted: 0, maxOfflineAllowed: 1 };
    }

    const online = partner.onlineOrdersCompleted || 0;
    const offline = partner.offlineOrdersCompleted || 0;

    // Allow at least 1 offline order initially, then requires 5 online orders per each subsequent offline order
    const maxOfflineAllowed = Math.floor(online / 5) + 1;
    const isEligible = offline < maxOfflineAllowed;

    return {
      isEligible,
      onlineCompleted: online,
      offlineCompleted: offline,
      maxOfflineAllowed,
      reason: isEligible
        ? undefined
        : `Partner offline quota reached (${offline}/${maxOfflineAllowed}). Partner must complete ${
            (offline + 1) * 5 - online
          } more online order(s) to maintain the 5:1 ratio balance.`,
    };
  }
}

export const partnerDispatchService = new PartnerDispatchService();
