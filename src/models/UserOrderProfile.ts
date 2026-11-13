import { Document, Schema, Model } from 'mongoose';
import { getOrdersDb } from '../config/database';

export interface IUserOrderProfile extends Document {
  userId: string;
  unpaidCancellationsCount: number;
  hasUsedCancellationMercy: boolean;
  penaltySurchargeApplies: boolean;
  totalOrdersCompleted: number;
  createdAt: Date;
  updatedAt: Date;
}

export const UserOrderProfileSchema = new Schema<IUserOrderProfile>(
  {
    userId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    unpaidCancellationsCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    hasUsedCancellationMercy: {
      type: Boolean,
      default: false,
    },
    penaltySurchargeApplies: {
      type: Boolean,
      default: false,
    },
    totalOrdersCompleted: {
      type: Number,
      default: 0,
      min: 0,
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

export const getUserOrderProfileModel = (): Model<IUserOrderProfile> => {
  const db = getOrdersDb();
  return db.models.UserOrderProfile || db.model<IUserOrderProfile>('UserOrderProfile', UserOrderProfileSchema);
};

