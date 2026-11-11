import { getUserDeviceModel, IUserDevice } from '../models/UserDevice';
import {
  deviceStreamEventSchema,
  DeviceStreamEventInput,
  DeviceStreamEventOutput,
} from '../schemas/device.schema';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { wsDispatcher } from '../websocket/ws-dispatcher';
import { alertService } from './alert.service';

export interface DeviceAnalyticsResult {
  totalDevicesRecorded: number;
  osDistribution: Record<string, { count: number; percentage: number }>;
  topBrands: { brand: string; count: number }[];
  topModels: { model: string; count: number }[];
  networkTypes: Record<string, number>;
  securityAnomalies: {
    rootedOrJailbrokenCount: number;
    emulatorCount: number;
  };
  timeframe: string;
}

export class DeviceStreamService {
  private recentEvents: DeviceStreamEventOutput[] = [];
  private readonly maxBufferSize = env.MAX_STREAM_BUFFER_SIZE;

  /**
   * Ingest a device telemetry stream event
   */
  async ingestDeviceEvent(rawEvent: DeviceStreamEventInput): Promise<{
    persisted: boolean;
    alertsTriggered: string[];
  }> {
    const event = deviceStreamEventSchema.parse(rawEvent);
    this.bufferEvent(event);
    const alertsTriggered: string[] = [];

    // 1. Critical Security Anomaly: Rooted or Jailbroken device
    if (event.isRootedOrJailbroken) {
      alertsTriggered.push('rooted_or_jailbroken');
      await alertService.createAlert({
        alertType: 'rooted_or_jailbroken',
        severity: 'critical',
        userId: event.userId,
        userName: event.userName,
        userEmail: event.userEmail,
        role: event.role,
        title: 'Rooted / Jailbroken Hardware Detected',
        description: `Device is running with elevated root privileges or compromised jailbreak environment.`,
        deviceInfo: {
          osName: event.osName,
          osVersion: event.osVersion,
          deviceBrand: event.deviceBrand,
          deviceModel: event.deviceModel,
        },
        metadata: {
          buildNumber: event.buildNumber,
          appVersion: event.appVersion,
          ipAddress: event.ipAddress,
        },
      });
    }

    // 2. Emulator / Botting detection
    if (event.isEmulator) {
      alertsTriggered.push('emulator_detected');
      await alertService.createAlert({
        alertType: 'emulator_detected',
        severity: 'high',
        userId: event.userId,
        userName: event.userName,
        userEmail: event.userEmail,
        role: event.role,
        title: 'Virtual Emulator Execution Detected',
        description: `Client execution detected inside virtualized Android Emulator or Xcode Simulator.`,
        deviceInfo: {
          osName: event.osName,
          osVersion: event.osVersion,
          deviceBrand: event.deviceBrand,
          deviceModel: event.deviceModel,
        },
      });
    }

    // 3. Critical low battery alert for delivery partners on active duty
    if (
      event.role === 'partner' &&
      event.batteryLevel !== undefined &&
      event.batteryLevel <= env.LOW_BATTERY_ALERT_THRESHOLD &&
      !event.isCharging
    ) {
      alertsTriggered.push('critical_low_battery');
      await alertService.createAlert({
        alertType: 'critical_low_battery',
        severity: 'medium',
        userId: event.userId,
        userName: event.userName,
        userEmail: event.userEmail,
        role: event.role,
        title: `Partner Battery Critical: ${event.batteryLevel}%`,
        description: `Delivery partner device battery is critically low (${event.batteryLevel}%) and not charging. Risk of dispatch communication cutoff.`,
        metadata: { batteryLevel: event.batteryLevel, lowPowerMode: event.lowPowerMode },
      });
    }

    // 4. Broadcast live device telemetry to WebSocket subscribers
    wsDispatcher.broadcastDevice(event);

    // 5. Persist to MongoDB UserDevice
    let persisted = false;
    try {
      const UserDevice = getUserDeviceModel();
      await UserDevice.create({
        userId: event.userId,
        userName: event.userName,
        userEmail: event.userEmail,
        role: event.role,
        osName: event.osName,
        osVersion: event.osVersion,
        deviceBrand: event.deviceBrand,
        deviceModel: event.deviceModel,
        deviceType: event.deviceType,
        appVersion: event.appVersion,
        buildNumber: event.buildNumber,
        ipAddress: event.ipAddress,
        userAgent: event.userAgent,
        screenResolution: event.screenResolution,
        deviceMemory: event.deviceMemory,
        networkType: event.networkType,
        carrier: event.carrier,
        batteryLevel: event.batteryLevel,
        lowPowerMode: event.lowPowerMode,
        isEmulator: event.isEmulator,
        isRootedOrJailbroken: event.isRootedOrJailbroken,
        timestamp: event.timestamp instanceof Date ? event.timestamp : new Date(event.timestamp),
      });
      persisted = true;
    } catch (err) {
      logger.debug('UserDevice async persistence note:', err);
    }

    return { persisted, alertsTriggered };
  }

  /**
   * Buffer device event in memory (sliding window)
   */
  private bufferEvent(event: DeviceStreamEventOutput): void {
    this.recentEvents.unshift(event);
    if (this.recentEvents.length > this.maxBufferSize) {
      this.recentEvents.pop();
    }
  }

  /**
   * Get buffered event stream
   */
  getBufferedEventStream(options: {
    limit?: number;
    since?: Date;
    osName?: string;
    role?: string;
  } = {}): DeviceStreamEventOutput[] {
    const limit = Math.min(500, Math.max(1, options.limit || 100));
    let filtered = this.recentEvents;

    if (options.since) {
      const sinceTime = options.since.getTime();
      filtered = filtered.filter((e) => new Date(e.timestamp).getTime() >= sinceTime);
    }

    if (options.osName) {
      filtered = filtered.filter((e) => e.osName === options.osName);
    }

    if (options.role) {
      filtered = filtered.filter((e) => e.role === options.role);
    }

    return filtered.slice(0, limit);
  }

  /**
   * Aggregate device analytics across the fleet
   */
  async getDeviceAnalytics(options: {
    timeframe: '24h' | '7d' | '30d' | 'all';
    role?: string;
  }): Promise<DeviceAnalyticsResult> {
    const UserDevice = getUserDeviceModel();
    const matchFilter: Record<string, any> = {};

    if (options.role) matchFilter.role = options.role;

    if (options.timeframe !== 'all') {
      const hours =
        options.timeframe === '24h' ? 24 : options.timeframe === '7d' ? 24 * 7 : 24 * 30;
      matchFilter.timestamp = { $gte: new Date(Date.now() - hours * 60 * 60 * 1000) };
    }

    // Try MongoDB aggregation pipeline
    try {
      const [osStats, brandStats, modelStats, networkStats, totalCount, securityCounts] =
        await Promise.all([
          UserDevice.aggregate([
            { $match: matchFilter },
            { $group: { _id: '$osName', count: { $sum: 1 } } },
          ]),
          UserDevice.aggregate([
            { $match: matchFilter },
            { $match: { deviceBrand: { $ne: null, $nin: ['', 'unknown'] } } },
            { $group: { _id: '$deviceBrand', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 10 },
          ]),
          UserDevice.aggregate([
            { $match: matchFilter },
            { $match: { deviceModel: { $ne: null, $nin: ['', 'unknown'] } } },
            { $group: { _id: '$deviceModel', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 10 },
          ]),
          UserDevice.aggregate([
            { $match: matchFilter },
            { $group: { _id: '$networkType', count: { $sum: 1 } } },
          ]),
          UserDevice.countDocuments(matchFilter),
          UserDevice.aggregate([
            { $match: matchFilter },
            {
              $group: {
                _id: null,
                rooted: { $sum: { $cond: ['$isRootedOrJailbroken', 1, 0] } },
                emulator: { $sum: { $cond: ['$isEmulator', 1, 0] } },
              },
            },
          ]),
        ]);

      const osDistribution: Record<string, { count: number; percentage: number }> = {};
      for (const item of osStats) {
        if (item._id) {
          osDistribution[item._id] = {
            count: item.count,
            percentage: totalCount > 0 ? Math.round((item.count / totalCount) * 1000) / 10 : 0,
          };
        }
      }

      const networkTypes: Record<string, number> = {};
      for (const item of networkStats) {
        networkTypes[item._id || 'unknown'] = item.count;
      }

      return {
        totalDevicesRecorded: totalCount,
        osDistribution,
        topBrands: brandStats.map((b) => ({ brand: b._id, count: b.count })),
        topModels: modelStats.map((m) => ({ model: m._id, count: m.count })),
        networkTypes,
        securityAnomalies: {
          rootedOrJailbrokenCount: securityCounts[0]?.rooted || 0,
          emulatorCount: securityCounts[0]?.emulator || 0,
        },
        timeframe: options.timeframe,
      };
    } catch (err) {
      logger.debug('Aggregating device analytics from in-memory buffer fallback:', err);
    }

    // Fallback: Compute from recentEvents in-memory buffer
    let filtered = this.recentEvents;
    if (options.role) filtered = filtered.filter((e) => e.role === options.role);

    const osMap: Record<string, number> = {};
    const brandMap: Record<string, number> = {};
    let rooted = 0;
    let emulator = 0;

    for (const e of filtered) {
      osMap[e.osName] = (osMap[e.osName] || 0) + 1;
      if (e.deviceBrand) brandMap[e.deviceBrand] = (brandMap[e.deviceBrand] || 0) + 1;
      if (e.isRootedOrJailbroken) rooted++;
      if (e.isEmulator) emulator++;
    }

    const total = filtered.length;
    const osDistribution: Record<string, { count: number; percentage: number }> = {};
    for (const [os, count] of Object.entries(osMap)) {
      osDistribution[os] = {
        count,
        percentage: total > 0 ? Math.round((count / total) * 1000) / 10 : 0,
      };
    }

    return {
      totalDevicesRecorded: total,
      osDistribution,
      topBrands: Object.entries(brandMap)
        .map(([brand, count]) => ({ brand, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
      topModels: [],
      networkTypes: {},
      securityAnomalies: {
        rootedOrJailbrokenCount: rooted,
        emulatorCount: emulator,
      },
      timeframe: options.timeframe,
    };
  }

  /**
   * Retrieve device history trail for a single user
   */
  async getUserDeviceHistory(userId: string, limit: number = 20): Promise<IUserDevice[]> {
    const UserDevice = getUserDeviceModel();
    return (await UserDevice.find({ userId }).sort({ timestamp: -1 }).limit(limit).lean()) as unknown as IUserDevice[];
  }
}

export const deviceStreamService = new DeviceStreamService();

