export type UserRole = 'user' | 'partner' | 'admin';

export interface LocationStreamEvent {
  id?: string;
  userId: string;
  userName: string;
  userEmail: string;
  role: UserRole;
  coordinates: {
    type: 'Point';
    coordinates: [number, number]; // [longitude, latitude]
  };
  latitude: number;
  longitude: number;
  accuracy?: number;
  altitude?: number;
  speed?: number; // meters/sec
  heading?: number;
  batteryLevel?: number;
  isMoving?: boolean;
  activityType?: string;
  timestamp: string | Date;
}

export type SupportedOS = 'ios' | 'android' | 'web' | 'windows' | 'macos' | 'linux' | 'other';
export type DeviceType = 'mobile' | 'tablet' | 'desktop' | 'wearable' | 'other';
export type NetworkType = 'wifi' | 'cellular_4g' | 'cellular_5g' | 'cellular_3g' | 'ethernet' | 'offline' | 'unknown';

export interface DeviceStreamEvent {
  id?: string;
  userId: string;
  userName: string;
  userEmail: string;
  role: UserRole;
  osName: SupportedOS;
  osVersion: string;
  deviceBrand: string;
  deviceModel: string;
  deviceType?: DeviceType;
  appVersion?: string;
  buildNumber?: string;
  isEmulator?: boolean;
  isRootedOrJailbroken?: boolean;
  batteryLevel?: number;
  isCharging?: boolean;
  networkType?: NetworkType;
  screenResolution?: string;
  ipAddress?: string;
  userAgent?: string;
  timestamp: string | Date;
}

export interface AuthUser {
  userId: string;
  email: string;
  role: UserRole;
  name?: string;
}

export interface APIResponse<T = any> {
  success: boolean;
  message?: string;
  data?: T;
  count?: number;
  total?: number;
  meta?: Record<string, any>;
  error?: {
    code: number;
    message: string;
    details?: any;
  };
}

