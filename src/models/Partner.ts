import { Document, Schema, Model } from 'mongoose';
import { getCoreDb } from '../config/database';

export type TransportMode = 'cycle' | 'walk';

export interface IPartner extends Document {
  partnerId: string;
  name: string;
  email: string;
  phone: string;
  isOnline: boolean;
  transportMode: TransportMode;
  currentLocation?: {
    type: 'Point';
    coordinates: [number, number]; // [longitude, latitude]
  };
  latitude?: number;
  longitude?: number;
  lastLocationUpdate?: Date;
  rating: number; // 1.0 to 5.0
  ratingCount: number;
  reputationScore: number; // 0 to 100, default 100
  mercyExtensionsUsedCount: number;
  unexcusedDelaysCount: number; // delays beyond mercy extension
  onlineOrdersCompleted: number; // 5:1 ratio tracker
  offlineOrdersCompleted: number; // 5:1 ratio tracker
  activeOrderId?: string | null;
  isBlocked: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const PartnerSchema = new Schema<IPartner>(
  {
    partnerId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    isOnline: {
      type: Boolean,
      default: false,
      index: true,
    },
    transportMode: {
      type: String,
      enum: ['cycle', 'walk'],
      default: 'cycle',
    },
    currentLocation: {
      type: {
        type: String,
        enum: ['Point'],
        default: 'Point',
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
      },
    },
    latitude: Number,
    longitude: Number,
    lastLocationUpdate: Date,
    rating: {
      type: Number,
      default: 5.0,
      min: 1.0,
      max: 5.0,
    },
    ratingCount: {
      type: Number,
      default: 0,
    },
    reputationScore: {
      type: Number,
      default: 100,
      min: 0,
      max: 100,
    },
    mercyExtensionsUsedCount: {
      type: Number,
      default: 0,
    },
    unexcusedDelaysCount: {
      type: Number,
      default: 0,
    },
    onlineOrdersCompleted: {
      type: Number,
      default: 0,
    },
    offlineOrdersCompleted: {
      type: Number,
      default: 0,
    },
    activeOrderId: {
      type: String,
      default: null,
    },
    isBlocked: {
      type: Boolean,
      default: false,
    },
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

PartnerSchema.index({ currentLocation: '2dsphere' });
PartnerSchema.index({ isOnline: 1, isBlocked: 1 });

export const getPartnerModel = (): Model<IPartner> => {
  const db = getCoreDb();
  return db.models.Partner || db.model<IPartner>('Partner', PartnerSchema);
};

