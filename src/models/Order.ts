import { Document, Schema, Model } from 'mongoose';
import { getOrdersDb } from '../config/database';

export type OrderStatus =
  | 'SEARCHING_PARTNER'
  | 'PAYMENT_PENDING'
  | 'PAID'
  | 'CASH_COLLECTION_IN_PROGRESS'
  | 'CASH_COLLECTED'
  | 'BUYING_PAGES'
  | 'WRITING_ASSIGNMENT'
  | 'PRINTING_IN_PROGRESS'
  | 'PRODUCT_PICKED_UP'
  | 'DELIVERY_IN_PROGRESS'
  | 'PARTNER_REACHED_DELIVERY'
  | 'DELIVERED'
  | 'CANCELLED_PAYMENT_TIMEOUT'
  | 'CANCELLED_SERVICE_UNAVAILABLE'
  | 'CANCELLED_BY_USER';

export type PaymentMode = 'ONLINE' | 'OFFLINE';

export type OrderType = 'STANDARD_PRODUCTS' | 'ASSIGNMENT_WRITING' | 'DOCUMENT_PRINTING';

export interface IAssignmentDetails {
  assignmentText: string;
  explanation: string;
  pageCount: number;
  wordCount: number;
  writingChargePerPage: number; // ₹1.00
  pagePricePerPage: number; // ₹1.00
  totalPageCharge: number; // pageCount * (writingChargePerPage + pagePricePerPage)
  handwrittenTimeMinutes: number;
  pageBuyingTimeMinutes: number;
  deliveryTravelEtaMinutes: number;
  totalEtaMinutes: number;
  estimatedDeliveryAt?: Date;
  nearestXeroxShop?: {
    name: string;
    latitude: number;
    longitude: number;
    distanceMeters: number;
    address?: string;
  };
  currentStage?: 'BUYING_PAGES' | 'WRITING_ASSIGNMENT' | 'OUT_FOR_DELIVERY' | 'ARRIVED' | 'DELIVERED';
  startedBuyingPagesAt?: Date;
  startedWritingAt?: Date;
  finishedWritingAt?: Date;
}

export interface IPrintingDetails {
  fileId?: string;
  fileName: string;
  fileUrl: string;
  googleDriveFileId?: string;
  googleDriveViewLink?: string;
  googleDriveDownloadLink?: string;
  mimeType: string;
  fileSizeBytes?: number;
  pageCount: number;
  copies: number;
  colorMode: 'BW' | 'COLOR';
  printSides?: 'SINGLE' | 'DOUBLE';
  printRatePerPage: number; // e.g. ₹2 for BW, ₹10 for Color
  totalPrintCharge: number;
  explanation?: string;
  currentStage?: 'PRINTING_IN_PROGRESS' | 'OUT_FOR_DELIVERY' | 'ARRIVED' | 'DELIVERED';
  startedPrintingAt?: Date;
  finishedPrintingAt?: Date;
}

export interface IOrderItem {
  productId: string;
  title: string;
  price: number; // in ₹
  quantity: number;
  subtotal: number;
}

export interface IOrder extends Document {
  orderId: string;
  orderType: OrderType;
  assignmentDetails?: IAssignmentDetails;
  printingDetails?: IPrintingDetails;
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
    orderType: {
      type: String,
      enum: ['STANDARD_PRODUCTS', 'ASSIGNMENT_WRITING', 'DOCUMENT_PRINTING'],
      default: 'STANDARD_PRODUCTS',
      index: true,
    },
    assignmentDetails: {
      assignmentText: String,
      explanation: String,
      pageCount: Number,
      wordCount: Number,
      writingChargePerPage: Number,
      pagePricePerPage: Number,
      totalPageCharge: Number,
      handwrittenTimeMinutes: Number,
      pageBuyingTimeMinutes: Number,
      deliveryTravelEtaMinutes: Number,
      totalEtaMinutes: Number,
      estimatedDeliveryAt: Date,
      nearestXeroxShop: {
        name: String,
        latitude: Number,
        longitude: Number,
        distanceMeters: Number,
        address: String,
      },
      currentStage: {
        type: String,
        enum: ['BUYING_PAGES', 'WRITING_ASSIGNMENT', 'OUT_FOR_DELIVERY', 'ARRIVED', 'DELIVERED'],
      },
      startedBuyingPagesAt: Date,
      startedWritingAt: Date,
      finishedWritingAt: Date,
    },
    printingDetails: {
      fileId: String,
      fileName: String,
      fileUrl: String,
      googleDriveFileId: String,
      googleDriveViewLink: String,
      googleDriveDownloadLink: String,
      mimeType: String,
      fileSizeBytes: Number,
      pageCount: Number,
      copies: Number,
      colorMode: {
        type: String,
        enum: ['BW', 'COLOR'],
      },
      printSides: {
        type: String,
        enum: ['SINGLE', 'DOUBLE'],
      },
      printRatePerPage: Number,
      totalPrintCharge: Number,
      explanation: String,
      currentStage: {
        type: String,
        enum: ['PRINTING_IN_PROGRESS', 'OUT_FOR_DELIVERY', 'ARRIVED', 'DELIVERED'],
      },
      startedPrintingAt: Date,
      finishedPrintingAt: Date,
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
      min: [0.0, 'Subtotal cannot be negative'],
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
        'BUYING_PAGES',
        'WRITING_ASSIGNMENT',
        'PRINTING_IN_PROGRESS',
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

