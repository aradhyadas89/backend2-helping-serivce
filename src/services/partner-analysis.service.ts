import { getPartnerModel, IPartner } from '../models/Partner';
import { getOrderModel } from '../models/Order';
import { NotFoundException } from '../middlewares/errorHandler';

export interface PartnerBehaviourReport {
  partnerId: string;
  name: string;
  email: string;
  transportMode: string;
  metrics: {
    totalOrdersCompleted: number;
    onlineOrdersCompleted: number;
    offlineOrdersCompleted: number;
    ordersDeliveredOnTime: number;
    onTimeDeliveryPercentage: number;
    mercyExtensionsUsedCount: number;
    unexcusedDelaysCount: number;
    averageRating: number;
    ratingCount: number;
    reputationScore: number;
    offlineRatioCompliance: {
      ratio: string;
      maxOfflineAllowed: number;
      canAcceptOfflineNow: boolean;
    };
  };
  scoring: {
    behaviouralScore: number; // 0 - 100
    reliabilityTier: 'ELITE_PERFORMER' | 'GOOD_STANDING' | 'NEEDS_COACHING' | 'AT_RISK_SUSPENDED';
    priorityDispatchBonus: boolean;
  };
  recommendations: string[];
}

export class PartnerAnalysisService {
  /**
   * Run comprehensive behavioral analysis on a delivery partner
   */
  async analyzePartnerBehaviour(partnerId: string): Promise<PartnerBehaviourReport> {
    const Partner = getPartnerModel();
    const Order = getOrderModel();

    const partner = await Partner.findOne({ partnerId });
    if (!partner) {
      throw new NotFoundException(`Partner ${partnerId} not found`);
    }

    // Aggregate fulfilled orders for this partner
    const completedOrders = await Order.find({
      assignedPartnerId: partnerId,
      status: 'DELIVERED',
    }).lean();

    const totalOrders = partner.onlineOrdersCompleted + partner.offlineOrdersCompleted;
    
    // Evaluate punctuality: orders without penalized trips
    const onTimeOrders = completedOrders.filter(
      (o) => !o.cashTripPenalized && !o.deliveryTripPenalized
    ).length;

    const onTimeDeliveryPercentage =
      completedOrders.length > 0
        ? Math.round((onTimeOrders / completedOrders.length) * 100)
        : 100;

    // 5:1 ratio calculation
    const maxOfflineAllowed = Math.floor(partner.onlineOrdersCompleted / 5) + 1;
    const canAcceptOfflineNow = partner.offlineOrdersCompleted < maxOfflineAllowed;

    // Calculate Behavioral Score (0 - 100)
    // 35% Punctuality + 30% Reputation + 25% Star Rating + 10% Ratio Adherence
    const punctualityComponent = onTimeDeliveryPercentage * 0.35;
    const reputationComponent = (partner.reputationScore || 100) * 0.30;
    const ratingComponent = ((partner.rating || 5.0) / 5.0) * 100 * 0.25;
    const ratioAdherenceComponent = canAcceptOfflineNow ? 10 : 5;

    const rawScore = Math.round(
      punctualityComponent + reputationComponent + ratingComponent + ratioAdherenceComponent
    );
    const behaviouralScore = Math.max(0, Math.min(100, rawScore));

    // Determine reliability tier
    let reliabilityTier: 'ELITE_PERFORMER' | 'GOOD_STANDING' | 'NEEDS_COACHING' | 'AT_RISK_SUSPENDED';
    let priorityDispatchBonus = false;

    if (behaviouralScore >= 90) {
      reliabilityTier = 'ELITE_PERFORMER';
      priorityDispatchBonus = true;
    } else if (behaviouralScore >= 75) {
      reliabilityTier = 'GOOD_STANDING';
    } else if (behaviouralScore >= 60) {
      reliabilityTier = 'NEEDS_COACHING';
    } else {
      reliabilityTier = 'AT_RISK_SUSPENDED';
    }

    // Generate actionable operational recommendations
    const recommendations: string[] = [];

    if (partner.transportMode === 'walk' && onTimeDeliveryPercentage < 80) {
      recommendations.push(
        'Upgrade vehicle to bicycle: Walking mode is causing delivery delays. Bicycle transport will improve average arrival speeds by ~3.3x (15 km/h vs 4.5 km/h).'
      );
    }

    if (partner.mercyExtensionsUsedCount > 3) {
      recommendations.push(
        'High reliance on mercy extensions detected. Consider restricting dispatch radius from 2.5km to 1.5km to prevent delays.'
      );
    }

    if (partner.unexcusedDelaysCount > 1) {
      recommendations.push(
        `Partner has ${partner.unexcusedDelaysCount} unexcused delays resulting in reputation deduction. Partner coaching session required.`
      );
    }

    if (!canAcceptOfflineNow) {
      recommendations.push(
        'Offline order quota exhausted under 5:1 ratio rule. Complete more online orders to unlock additional cash pickups.'
      );
    }

    if (recommendations.length === 0) {
      recommendations.push(
        'Outstanding performance! Partner maintains optimal punctuality and reputation. Eligible for fleet bonuses.'
      );
    }

    return {
      partnerId: partner.partnerId,
      name: partner.name,
      email: partner.email,
      transportMode: partner.transportMode,
      metrics: {
        totalOrdersCompleted: totalOrders,
        onlineOrdersCompleted: partner.onlineOrdersCompleted,
        offlineOrdersCompleted: partner.offlineOrdersCompleted,
        ordersDeliveredOnTime: onTimeOrders,
        onTimeDeliveryPercentage,
        mercyExtensionsUsedCount: partner.mercyExtensionsUsedCount,
        unexcusedDelaysCount: partner.unexcusedDelaysCount,
        averageRating: partner.rating,
        ratingCount: partner.ratingCount,
        reputationScore: partner.reputationScore,
        offlineRatioCompliance: {
          ratio: '5 Online : 1 Offline',
          maxOfflineAllowed,
          canAcceptOfflineNow,
        },
      },
      scoring: {
        behaviouralScore,
        reliabilityTier,
        priorityDispatchBonus,
      },
      recommendations,
    };
  }
}

export const partnerAnalysisService = new PartnerAnalysisService();
