import { Document, Schema, Model } from 'mongoose';
import { getOrdersDb } from '../config/database';

export type OrderStatus =
  | 'SEARCHING_PARTNER'
  | 'PAYMENT_PENDING'
  | 'PAID'
  | 'CASH_COLLECTION_IN_PROGRESS'
  | 'CASH_COLLECTED'
  | 'PRODUCT_PICKED_UP'
  | 'DELIVERY_IN_PROGRESS'
  | 'PARTNER_REACHED_DELIVERY'
  | 'DELIVERED'
  | 'CANCELLED_PAYMENT_TIMEOUT'
  | 'CANCELLED_SERVICE_UNAVAILABLE'
  | 'CANCELLED_BY_USER';

export type PaymentMode = 'ONLINE' | 'OFFLINE';

export interface IOrderItem {
  productId: string;
  title: string;
  price: number; // in ₹
  quantity: number;
  subtotal: number;
}

export interface IOrder extends Document {
  orderId: string;
  userId: string;
  userName: string;
  userEmail: string;
  userPhone: string;
  deliveryLocation: {
    type: 'Point';
    coordinates: [number, number]; // [longitude, latitude]
  };
  latitude: number;
  longitude: number;
  deliveryAddress: string;

  items: IOrderItem[];
  subtotal: number; // Must be >= ₹30
  deliveryFee: number;
  cancellationPenaltySurcharge: number; // ₹0.30 if prior cancellations >= 2
  totalAmount: number;

  status: OrderStatus;

  // Partner Assignment
  assignedPartnerId?: string | null;
  assignedPartnerName?: string;
  assignedPartnerPhone?: string;
  partnerTransportMode?: 'cycle' | 'walk';
  partnerAcceptedAt?: Date;

  // 1-minute payment selection window
  paymentMode?: PaymentMode | null;
  paymentSelectionExpiresAt?: Date;

  // Online Gateway
  razorpayOrderId?: string;
  razorpayPaymentId?: string;
  razorpaySignature?: string;
  isPaid: boolean;
  paidAt?: Date;
  refundStatus?: 'NONE' | 'INITIATED' | 'COMPLETED' | 'FAILED';
  razorpayRefundId?: string;
  refundAmount?: number;
  refundedAt?: Date;

  // Offline Cash Collection Handshake
  cashCollectionOtp?: string;
  cashCollectionOtpExpiresAt?: Date;
  failedCashOtpAttempts?: number;
  isCashCollected: boolean;
  cashCollectedAt?: Date;
  cashTripEtaSeconds?: number;
  cashTripExpiresAt?: Date;
  cashTripMercyUsed: boolean;
  cashTripPenalized: boolean;

  // Delivery Handshake
  deliveryOtp?: string;
  deliveryOtpExpiresAt?: Date;
  failedDeliveryOtpAttempts?: number;
  deliveryTripEtaSeconds?: number;
  deliveryTripExpiresAt?: Date;
  deliveryTripMercyUsed: boolean;
  deliveryTripPenalized: boolean;
  deliveredAt?: Date;

  // Partner Dispatched Rings
  notifiedPartnerIds: string[];
  ringBandsNotified: number[];

  // Customer Rating & Feedback
  isRated?: boolean;
  rating?: number;
  ratingFeedback?: string;
  ratedAt?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const OrderItemSchema = new Schema<IOrderItem>(
  {
    productId: { type: String, required: true },
    title: { type: String, required: true },
    price: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1 },
    subtotal: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

export const OrderSchema = new Schema<IOrder>(
  {
    orderId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    userId: {
      type: String,
      required: true,
      index: true,
    },
    userName: {
      type: String,
      required: true,
    },
    userEmail: {
      type: String,
      required: true,
      lowercase: true,
    },
    userPhone: {
      type: String,
      required: true,
    },
    deliveryLocation: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
        required: true,
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        required: true,
      },
    },
    latitude: {
      type: Number,
      required: true,
    },
    longitude: {
      type: Number,
      required: true,
    },
    deliveryAddress: {
      type: String,
      required: true,
    },
    items: {
      type: [OrderItemSchema],
      required: true,
      validate: [(val: any[]) => val.length > 0, 'Order must contain at least one item'],
    },
    subtotal: {
      type: Number,
      required: true,
      min: [30.0, 'Minimum order value is ₹30.00'],
    },
    deliveryFee: {
      type: Number,
      default: 15.0,
      min: 0,
    },
    cancellationPenaltySurcharge: {
      type: Number,
      default: 0.0,
      min: 0,
    },
    totalAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    status: {
      type: String,
      enum: [
        'SEARCHING_PARTNER',
        'PAYMENT_PENDING',
        'PAID',
        'CASH_COLLECTION_IN_PROGRESS',
        'CASH_COLLECTED',
        'PRODUCT_PICKED_UP',
        'DELIVERY_IN_PROGRESS',
        'PARTNER_REACHED_DELIVERY',
        'DELIVERED',
        'CANCELLED_PAYMENT_TIMEOUT',
        'CANCELLED_SERVICE_UNAVAILABLE',
        'CANCELLED_BY_USER',
      ],
      default: 'SEARCHING_PARTNER',
      index: true,
    },
    assignedPartnerId: {
      type: String,
      default: null,
      index: true,
    },
    assignedPartnerName: String,
    assignedPartnerPhone: String,
    partnerTransportMode: {
      type: String,
      enum: ['cycle', 'walk'],
    },
    partnerAcceptedAt: Date,
    paymentMode: {
      type: String,
      enum: ['ONLINE', 'OFFLINE'],
    },
    paymentSelectionExpiresAt: Date,
    razorpayOrderId: String,
    razorpayPaymentId: String,
    razorpaySignature: String,
    isPaid: {
      type: Boolean,
      default: false,
    },
    paidAt: Date,
    refundStatus: {
      type: String,
      enum: ['NONE', 'INITIATED', 'COMPLETED', 'FAILED'],
      default: 'NONE',
    },
    razorpayRefundId: String,
    refundAmount: Number,
    refundedAt: Date,
    cashCollectionOtp: String,
    cashCollectionOtpExpiresAt: Date,
    failedCashOtpAttempts: {
      type: Number,
      default: 0,
    },
    isCashCollected: {
      type: Boolean,
      default: false,
    },
    cashCollectedAt: Date,
    cashTripEtaSeconds: Number,
    cashTripExpiresAt: Date,
    cashTripMercyUsed: {
      type: Boolean,
      default: false,
    },
    cashTripPenalized: {
      type: Boolean,
      default: false,
    },
    deliveryOtp: String,
    deliveryOtpExpiresAt: Date,
    failedDeliveryOtpAttempts: {
      type: Number,
      default: 0,
    },
    deliveryTripEtaSeconds: Number,
    deliveryTripExpiresAt: Date,
    deliveryTripMercyUsed: {
      type: Boolean,
      default: false,
    },
    deliveryTripPenalized: {
      type: Boolean,
      default: false,
    },
    deliveredAt: Date,
    notifiedPartnerIds: {
      type: [String],
      default: [],
    },
    ringBandsNotified: {
      type: [Number],
      default: [],
    },
    isRated: {
      type: Boolean,
      default: false,
    },
    rating: {
      type: Number,
      min: 1.0,
      max: 5.0,
    },
    ratingFeedback: String,
    ratedAt: Date,
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret: Record<string, any>) {
        ret.id = ret._id;
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

OrderSchema.index({ deliveryLocation: '2dsphere' });
OrderSchema.index({ userId: 1, createdAt: -1 });
OrderSchema.index({ assignedPartnerId: 1, status: 1 });

export const getOrderModel = (): Model<IOrder> => {
  const db = getOrdersDb();
  return db.models.Order || db.model<IOrder>('Order', OrderSchema);
};

