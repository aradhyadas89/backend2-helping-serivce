import { Document, Schema, Model } from 'mongoose';
import { getTelemetryDb } from '../config/database';

export type AlertType =
  | 'rooted_or_jailbroken'
  | 'emulator_detected'
  | 'speed_violation'
  | 'geofence_breach'
  | 'critical_low_battery'
  | 'mocked_location_spoofing'
  | 'brute_force_detected'
  | 'unauthorized_access_attempt'
  | 'nosql_injection_attempt'
  | 'token_revoked_or_blocked'
  | 'suspicious_withdrawal_attempt';

export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low';
export type AlertStatus = 'open' | 'acknowledged' | 'resolved' | 'dismissed';

export interface ISecurityAlert extends Document {
  alertType: AlertType;
  severity: AlertSeverity;
  status: AlertStatus;
  userId: string;
  userName?: string;
  userEmail?: string;
  role: 'user' | 'partner' | 'admin';
  title: string;
  description: string;
  metadata?: Record<string, any>;
  location?: {
    latitude: number;
    longitude: number;
  };
  deviceInfo?: {
    osName: string;
    osVersion?: string;
    deviceBrand?: string;
    deviceModel?: string;
  };
  acknowledgedBy?: string;
  acknowledgedAt?: Date;
  resolvedBy?: string;
  resolvedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export const SecurityAlertSchema = new Schema<ISecurityAlert>(
  {
    alertType: {
      type: String,
      enum: [
        'rooted_or_jailbroken',
        'emulator_detected',
        'speed_violation',
        'geofence_breach',
        'critical_low_battery',
        'mocked_location_spoofing',
        'brute_force_detected',
        'unauthorized_access_attempt',
        'nosql_injection_attempt',
        'token_revoked_or_blocked',
        'suspicious_withdrawal_attempt',
      ],
      required: true,
      index: true,
    },
    severity: {
      type: String,
      enum: ['critical', 'high', 'medium', 'low'],
      default: 'medium',
      index: true,
    },
    status: {
      type: String,
      enum: ['open', 'acknowledged', 'resolved', 'dismissed'],
      default: 'open',
      index: true,
    },
    userId: {
      type: String,
      required: true,
      index: true,
    },
    userName: {
      type: String,
      trim: true,
    },
    userEmail: {
      type: String,
      trim: true,
      lowercase: true,
    },
    role: {
      type: String,
      enum: ['user', 'partner', 'admin'],
      default: 'user',
      index: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
    },
    metadata: {
      type: Schema.Types.Mixed,
    },
    location: {
      latitude: Number,
      longitude: Number,
    },
    deviceInfo: {
      osName: String,
      osVersion: String,
      deviceBrand: String,
      deviceModel: String,
    },
    acknowledgedBy: {
      type: String,
    },
    acknowledgedAt: {
      type: Date,
    },
    resolvedBy: {
      type: String,
    },
    resolvedAt: {
      type: Date,
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

SecurityAlertSchema.index({ status: 1, severity: 1, createdAt: -1 });
SecurityAlertSchema.index({ userId: 1, createdAt: -1 });

export const getSecurityAlertModel = (): Model<ISecurityAlert> => {
  const db = getTelemetryDb();
  return db.models.SecurityAlert || db.model<ISecurityAlert>('SecurityAlert', SecurityAlertSchema);
};

