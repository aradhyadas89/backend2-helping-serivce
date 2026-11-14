import { getProductModel } from '../models/Product';
import { getUserOrderProfileModel } from '../models/UserOrderProfile';
import { BadRequestException } from '../middlewares/errorHandler';

export interface BillingCalculationResult {
  items: Array<{
    productId: string;
    title: string;
    price: number;
    quantity: number;
    subtotal: number;
  }>;
  subtotal: number;
  deliveryFee: number;
  cancellationPenaltySurcharge: number;
  totalAmount: number;
  cancellationCount: number;
  penaltyApplied: boolean;
}

export class PricingService {
  /**
   * Minimum mandatory order threshold in Rupees (₹)
   */
  public readonly MIN_ORDER_AMOUNT = 30.0;

  /**
   * Surcharge penalty applied on users with >= 2 unpaid cancellations (30 paisa = ₹0.30)
   */
  public readonly CANCELLATION_SURCHARGE_RUPEES = 0.3;

  /**
   * Calculate full pricing, billing breakdown, and enforce minimum order rules
   */
  async calculateBilling(
    userId: string,
    rawItems: Array<{ productId: string; quantity: number }>,
    distanceMeters: number = 1000
  ): Promise<BillingCalculationResult> {
    const Product = getProductModel();
    const productIds = rawItems.map((i) => i.productId);

    const products = await Product.find({ _id: { $in: productIds }, isActive: true, isDeleted: false });

    if (products.length !== rawItems.length) {
      throw new BadRequestException('One or more selected products are unavailable or discontinued');
    }

    const productMap = new Map(products.map((p) => [p._id.toString(), p]));

    let subtotal = 0.0;
    const items = rawItems.map((raw) => {
      const product = productMap.get(raw.productId)!;
      const unitPrice = product.discountPrice !== undefined && product.discountPrice > 0
        ? product.discountPrice
        : product.price;

      const itemSubtotal = Math.round(unitPrice * raw.quantity * 100) / 100;
      subtotal += itemSubtotal;

      return {
        productId: product._id.toString(),
        title: product.title,
        price: unitPrice,
        quantity: raw.quantity,
        subtotal: itemSubtotal,
      };
    });

    subtotal = Math.round(subtotal * 100) / 100;

    // 1. Minimum Order Value Check (>= ₹30)
    if (subtotal < this.MIN_ORDER_AMOUNT) {
      throw new BadRequestException(
        `Minimum order value is ₹${this.MIN_ORDER_AMOUNT.toFixed(2)}. Current items subtotal is ₹${subtotal.toFixed(2)}. Please add more items to proceed.`
      );
    }

    // 2. Base Delivery Fee (Tiered by distance)
    let deliveryFee = 15.0; // Base ₹15
    if (distanceMeters > 1500) {
      deliveryFee += Math.round(((distanceMeters - 1500) / 500) * 5 * 100) / 100;
    }

    // 3. User Cancellation Penalty Check
    // If user has >= 2 cancellations without payment selection, apply 30 paisa surcharge
    const UserOrderProfile = getUserOrderProfileModel();
    const userProfile = await UserOrderProfile.findOne({ userId });

    let cancellationPenaltySurcharge = 0.0;
    let penaltyApplied = false;
    const cancellationCount = userProfile?.unpaidCancellationsCount || 0;

    if (cancellationCount >= 2) {
      cancellationPenaltySurcharge = this.CANCELLATION_SURCHARGE_RUPEES;
      penaltyApplied = true;
    }

    const totalAmount = Math.round((subtotal + deliveryFee + cancellationPenaltySurcharge) * 100) / 100;

    return {
      items,
      subtotal,
      deliveryFee,
      cancellationPenaltySurcharge,
      totalAmount,
      cancellationCount,
      penaltyApplied,
    };
  }

  /**
   * Preview bill calculation without throwing error if below ₹30 (for checkout UI)
   */
  async estimateBilling(
    userId: string,
    rawItems: Array<{ productId: string; quantity: number }>,
    distanceMeters: number = 1000
  ): Promise<{
    items: Array<{ productId: string; title: string; price: number; quantity: number; subtotal: number }>;
    subtotal: number;
    deliveryFee: number;
    cancellationPenaltySurcharge: number;
    totalAmount: number;
    canOrder: boolean;
    minimumOrderRequirement: number;
    amountShort: number;
    penaltyApplied: boolean;
  }> {
    const Product = getProductModel();
    const productIds = rawItems.map((i) => i.productId);

    const products = await Product.find({ _id: { $in: productIds }, isActive: true, isDeleted: false });
    const productMap = new Map(products.map((p) => [p._id.toString(), p]));

    let subtotal = 0.0;
    const items = rawItems
      .filter((raw) => productMap.has(raw.productId))
      .map((raw) => {
        const product = productMap.get(raw.productId)!;
        const unitPrice =
          product.discountPrice !== undefined && product.discountPrice > 0
            ? product.discountPrice
            : product.price;

        const itemSubtotal = Math.round(unitPrice * raw.quantity * 100) / 100;
        subtotal += itemSubtotal;

        return {
          productId: product._id.toString(),
          title: product.title,
          price: unitPrice,
          quantity: raw.quantity,
          subtotal: itemSubtotal,
        };
      });

    subtotal = Math.round(subtotal * 100) / 100;
    const canOrder = subtotal >= this.MIN_ORDER_AMOUNT;
    const amountShort = canOrder ? 0 : Math.round((this.MIN_ORDER_AMOUNT - subtotal) * 100) / 100;

    let deliveryFee = 15.0;
    if (distanceMeters > 1500) {
      deliveryFee += Math.round(((distanceMeters - 1500) / 500) * 5 * 100) / 100;
    }

    const UserOrderProfile = getUserOrderProfileModel();
    const userProfile = await UserOrderProfile.findOne({ userId });

    let cancellationPenaltySurcharge = 0.0;
    let penaltyApplied = false;
    if ((userProfile?.unpaidCancellationsCount || 0) >= 2) {
      cancellationPenaltySurcharge = this.CANCELLATION_SURCHARGE_RUPEES;
      penaltyApplied = true;
    }

    const totalAmount = Math.round((subtotal + deliveryFee + cancellationPenaltySurcharge) * 100) / 100;

    return {
      items,
      subtotal,
      deliveryFee,
      cancellationPenaltySurcharge,
      totalAmount,
      canOrder,
      minimumOrderRequirement: this.MIN_ORDER_AMOUNT,
      amountShort,
      penaltyApplied,
    };
  }
}

export const pricingService = new PricingService();

