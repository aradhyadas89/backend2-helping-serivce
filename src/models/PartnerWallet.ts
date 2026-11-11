import { Document, Schema, Model } from 'mongoose';
import { getAnalyticsDb } from '../config/database';

export interface IWalletTransaction {
  transactionId: string;
  orderId?: string;
  amount: number; // in ₹
  type: 'credit' | 'debit';
  category: 'delivery_fee' | 'cash_settlement' | 'bonus' | 'penalty_deduction';
  description: string;
  createdAt: Date;
}

export interface IPartnerWallet extends Document {
  partnerId: string;
  virtualBalance: number; // in ₹ (virtual delivery earnings ledger)
  pendingCashHold: number; // offline cash collected physically in-hand
  totalEarned: number;
  transactions: IWalletTransaction[];
  createdAt: Date;
  updatedAt: Date;
}

const WalletTransactionSchema = new Schema<IWalletTransaction>(
  {
    transactionId: {
      type: String,
      required: true,
    },
    orderId: {
      type: String,
    },
    amount: {
      type: Number,
      required: true,
    },
    type: {
      type: String,
      enum: ['credit', 'debit'],
      required: true,
    },
    category: {
      type: String,
      enum: ['delivery_fee', 'cash_settlement', 'bonus', 'penalty_deduction'],
      required: true,
    },
    description: {
      type: String,
      required: true,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

export const PartnerWalletSchema = new Schema<IPartnerWallet>(
  {
    partnerId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    virtualBalance: {
      type: Number,
      default: 0.0,
      min: 0,
    },
    pendingCashHold: {
      type: Number,
      default: 0.0,
      min: 0,
    },
    totalEarned: {
      type: Number,
      default: 0.0,
      min: 0,
    },
    transactions: {
      type: [WalletTransactionSchema],
      default: [],
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

export const getPartnerWalletModel = (): Model<IPartnerWallet> => {
  const db = getAnalyticsDb();
  return db.models.PartnerWallet || db.model<IPartnerWallet>('PartnerWallet', PartnerWalletSchema);
};
