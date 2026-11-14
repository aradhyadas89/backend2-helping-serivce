import { calculateHaversineDistance } from '../utils/geo.utils';
import { googleMapsService } from './google-maps.service';
import { TransportMode } from '../models/Partner';
import { logger } from '../config/logger';

export interface XeroxShop {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  address: string;
  phone?: string;
}

export interface NearestShopResult {
  shop: XeroxShop;
  distanceMeters: number;
}

export interface AssignmentTimingsResult {
  nearestShop: {
    name: string;
    latitude: number;
    longitude: number;
    distanceMeters: number;
    address: string;
  };
  pageBuyingSeconds: number;
  pageBuyingMinutes: number;
  handwrittenSeconds: number;
  handwrittenMinutes: number;
  deliveryTravelSeconds: number;
  deliveryTravelMinutes: number;
  totalEtaSeconds: number;
  totalEtaMinutes: number;
  estimatedDeliveryAt: Date;
}

export class XeroxShopService {
  // Curated network of verified Xerox & stationery hubs in the delivery zone
  private registeredShops: XeroxShop[] = [
    {
      id: 'SHOP-XRX-01',
      name: 'Central Campus Xerox & Stationery Hub',
      latitude: 22.5745,
      longitude: 88.3648,
      address: 'Main Gate Market, University Avenue',
      phone: '9830112233',
    },
    {
      id: 'SHOP-XRX-02',
      name: 'Student Corner Stationery & Photocopy',
      latitude: 22.5715,
      longitude: 88.3620,
      address: 'Hostel Road, Near Gate 4',
      phone: '9830223344',
    },
    {
      id: 'SHOP-XRX-03',
      name: 'Quick Print & Digital Xerox Mart',
      latitude: 22.5755,
      longitude: 88.3665,
      address: 'Academic Complex Commercial Strip',
      phone: '9830334455',
    },
    {
      id: 'SHOP-XRX-04',
      name: 'Apex Print, Binding & Paper Mart',
      latitude: 22.5700,
      longitude: 88.3650,
      address: 'South Campus Extension, Street 12',
      phone: '9830445566',
    },
    {
      id: 'SHOP-XRX-05',
      name: 'Tech Point Xerox & Cyber Services',
      latitude: 22.5735,
      longitude: 88.3615,
      address: 'Engineering Block Plaza, Shop 8',
      phone: '9830556677',
    },
  ];

  /**
   * Find nearest Xerox / Stationery shop from partner's live coordinates
   */
  findNearestXeroxShop(partnerLat: number, partnerLon: number): NearestShopResult {
    let nearest = this.registeredShops[0];
    let minDistance = calculateHaversineDistance(
      partnerLat,
      partnerLon,
      nearest.latitude,
      nearest.longitude
    );

    for (let i = 1; i < this.registeredShops.length; i++) {
      const shop = this.registeredShops[i];
      const dist = calculateHaversineDistance(partnerLat, partnerLon, shop.latitude, shop.longitude);
      if (dist < minDistance) {
        minDistance = dist;
        nearest = shop;
      }
    }

    return {
      shop: nearest,
      distanceMeters: Math.round(minDistance),
    };
  }

  /**
   * Calculate human handwriting time:
   * Average handwriting speed is ~20 words/minute + 3 minutes per page for formatting, reading explanation & margins.
   */
  calculateHandwrittenTime(wordCount: number, pageCount: number): { handwrittenMinutes: number; handwrittenSeconds: number } {
    // Standard baseline: ~12 minutes per handwritten page (min 10 mins)
    const writingMinutes = Math.max(10, Math.max(pageCount * 12, Math.ceil(wordCount / 20) + (pageCount * 3)));
    return {
      handwrittenMinutes: writingMinutes,
      handwrittenSeconds: writingMinutes * 60,
    };
  }

  /**
   * Comprehensive Algorithm:
   * 1. Partner travels to nearest Xerox shop to buy blank pages.
   * 2. Partner buys paper + pens at the shop (5 mins buffer).
   * 3. Partner writes the assignment by hand based on user explanation.
   * 4. Partner travels from xerox shop / writing location to user's real-time location.
   */
  async calculateAssignmentTimings(
    partnerLoc: { latitude: number; longitude: number },
    userLoc: { latitude: number; longitude: number },
    pageCount: number,
    wordCount: number,
    transportMode: TransportMode = 'cycle'
  ): Promise<AssignmentTimingsResult> {
    // 1. Locate nearest xerox shop
    const { shop, distanceMeters: shopDistance } = this.findNearestXeroxShop(
      partnerLoc.latitude,
      partnerLoc.longitude
    );

    // 2. Travel to shop
    const shopRoute = await googleMapsService.calculateRoute(
      partnerLoc,
      { latitude: shop.latitude, longitude: shop.longitude },
      transportMode
    );

    // 3. Shop purchase buffer: 5 minutes (300 seconds)
    const shopBuyingBufferSeconds = 300;
    const pageBuyingSeconds = shopRoute.durationSeconds + shopBuyingBufferSeconds;
    const pageBuyingMinutes = Math.ceil(pageBuyingSeconds / 60);

    // 4. Handwriting time
    const { handwrittenSeconds, handwrittenMinutes } = this.calculateHandwrittenTime(wordCount, pageCount);

    // 5. Delivery travel route from shop location to user's location
    const deliveryRoute = await googleMapsService.calculateRoute(
      { latitude: shop.latitude, longitude: shop.longitude },
      userLoc,
      transportMode
    );

    const deliveryTravelSeconds = deliveryRoute.durationSeconds;
    const deliveryTravelMinutes = Math.ceil(deliveryTravelSeconds / 60);

    // 6. Total ETA
    const totalEtaSeconds = pageBuyingSeconds + handwrittenSeconds + deliveryTravelSeconds;
    const totalEtaMinutes = Math.ceil(totalEtaSeconds / 60);
    const estimatedDeliveryAt = new Date(Date.now() + totalEtaSeconds * 1000);

    logger.info(
      `[ASSIGNMENT TIMINGS] ${pageCount} pages (${wordCount} words) -> Buy: ${pageBuyingMinutes}m, Write: ${handwrittenMinutes}m, Deliver: ${deliveryTravelMinutes}m = Total ${totalEtaMinutes}m`
    );

    return {
      nearestShop: {
        name: shop.name,
        latitude: shop.latitude,
        longitude: shop.longitude,
        distanceMeters: shopDistance,
        address: shop.address,
      },
      pageBuyingSeconds,
      pageBuyingMinutes,
      handwrittenSeconds,
      handwrittenMinutes,
      deliveryTravelSeconds,
      deliveryTravelMinutes,
      totalEtaSeconds,
      totalEtaMinutes,
      estimatedDeliveryAt,
    };
  }
}

export const xeroxShopService = new XeroxShopService();
