import { Document, Schema, Model } from 'mongoose';
import { getAnalyticsDb } from '../config/database';

export type GeofenceShape = 'circle' | 'polygon';

export interface IGeofenceZone extends Document {
  name: string;
  code: string;
  description?: string;
  shape: GeofenceShape;
  // For circle: center [longitude, latitude] & radiusMeters
  center?: {
    type: 'Point';
    coordinates: [number, number];
  };
  radiusMeters?: number;
  // For polygon: GeoJSON Polygon
  geometry?: {
    type: 'Polygon';
    coordinates: number[][][]; // GeoJSON polygon coordinates
  };
  category: 'campus' | 'service_hub' | 'restricted' | 'high_demand';
  isActive: boolean;
  alertOnExit: boolean;
  alertOnEntry: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const GeofenceZoneSchema = new Schema<IGeofenceZone>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },
    description: {
      type: String,
      trim: true,
    },
    shape: {
      type: String,
      enum: ['circle', 'polygon'],
      required: true,
    },
    center: {
      type: {
        type: String,
        enum: ['Point'],
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
      },
    },
    radiusMeters: {
      type: Number,
      min: 10,
    },
    geometry: {
      type: {
        type: String,
        enum: ['Polygon'],
      },
      coordinates: {
        type: [[[Number]]],
      },
    },
    category: {
      type: String,
      enum: ['campus', 'service_hub', 'restricted', 'high_demand'],
      default: 'campus',
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    alertOnExit: {
      type: Boolean,
      default: false,
    },
    alertOnEntry: {
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

GeofenceZoneSchema.index({ 'center': '2dsphere' });
GeofenceZoneSchema.index({ 'geometry': '2dsphere' });

export const getGeofenceZoneModel = (): Model<IGeofenceZone> => {
  const db = getAnalyticsDb();
  return db.models.GeofenceZone || db.model<IGeofenceZone>('GeofenceZone', GeofenceZoneSchema);
};

