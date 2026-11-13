import { getUserLocationModel, IUserLocation } from '../models/UserLocation';
import {
  locationStreamEventSchema,
  LocationStreamEventInput,
  LocationStreamEventOutput,
} from '../schemas/location.schema';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { wsDispatcher } from '../websocket/ws-dispatcher';
import { alertService } from './alert.service';
import { geofenceService } from './geofence.service';
import { mpsToKmph, calculateHaversineDistance } from '../utils/geo.utils';

export interface LiveUserPosition {
  userId: string;
  userName?: string;
  userEmail?: string;
  role: 'user' | 'partner' | 'admin';
  latitude: number;
  longitude: number;
  accuracy?: number;
  speed?: number;
  speedKmph?: number;
  heading?: number;
  batteryLevel?: number;
  isMocked?: boolean;
  activity?: string;
  insideZones?: string[];
  lastPingAt: Date;
}

export class LocationStreamService {
  /**
   * In-memory sliding ring buffer holding recent raw location events
   */
  private recentEvents: LocationStreamEventOutput[] = [];
  private readonly maxBufferSize = env.MAX_STREAM_BUFFER_SIZE;

  /**
   * Live active positions map keyed by userId for ultra-fast O(1) live map rendering
   */
  private livePositions: Map<string, LiveUserPosition> = new Map();

  /**
   * Ingest a location stream event (called by Main Backend webhook or internal dispatcher)
   */
  async ingestLocationEvent(rawEvent: LocationStreamEventInput): Promise<{
    persisted: boolean;
    insideZones: string[];
  }> {
    const event = locationStreamEventSchema.parse(rawEvent);

    // 1. Sliding in-memory buffer push
    this.bufferEvent(event);

    const speedKmph = event.speed !== undefined ? mpsToKmph(event.speed) : undefined;

    // 2. Geofence evaluation
    const { insideZones } = await geofenceService.evaluateLocation({
      userId: event.userId,
      userName: event.userName,
      userEmail: event.userEmail,
      role: event.role,
      latitude: event.latitude,
      longitude: event.longitude,
    });

    // 3. Update live map cache
    const livePos: LiveUserPosition = {
      userId: event.userId,
      userName: event.userName,
      userEmail: event.userEmail,
      role: event.role,
      latitude: event.latitude,
      longitude: event.longitude,
      accuracy: event.accuracy,
      speed: event.speed,
      speedKmph,
      heading: event.heading,
      batteryLevel: event.batteryLevel,
      isMocked: event.isMocked,
      activity: event.activityType,
      insideZones,
      lastPingAt: event.timestamp instanceof Date ? event.timestamp : new Date(event.timestamp),
    };
    this.livePositions.set(event.userId, livePos);

    // 4. Anomaly detection: Speed threshold violation
    if (speedKmph !== undefined && speedKmph > env.SPEED_ALERT_THRESHOLD_KMPH) {
      await alertService.createAlert({
        alertType: 'speed_violation',
        severity: 'high',
        userId: event.userId,
        userName: event.userName,
        userEmail: event.userEmail,
        role: event.role,
        title: `Excessive Speed Detected: ${Math.round(speedKmph)} km/h`,
        description: `User/Partner exceeded speed threshold (${env.SPEED_ALERT_THRESHOLD_KMPH} km/h) traveling at ${Math.round(speedKmph)} km/h.`,
        metadata: { speedKmph, recordedSpeedMps: event.speed },
        location: { latitude: event.latitude, longitude: event.longitude },
      });
    }

    // 5. Anomaly detection: Mocked location / GPS spoofing
    if (event.isMocked) {
      await alertService.createAlert({
        alertType: 'mocked_location_spoofing',
        severity: 'critical',
        userId: event.userId,
        userName: event.userName,
        userEmail: event.userEmail,
        role: event.role,
        title: 'Mocked GPS / Location Spoofing Detected',
        description: `Device reported mocked GPS coordinates. Potential location spoofing or emulator activity.`,
        location: { latitude: event.latitude, longitude: event.longitude },
      });
    }

    // 6. Broadcast real-time update to WebSocket subscribers
    wsDispatcher.broadcastLocation({
      ...livePos,
      timestamp: livePos.lastPingAt.toISOString(),
    });

    // 7. Persist to MongoDB UserLocation (if not already stored by main backend)
    let persisted = false;
    try {
      const UserLocation = getUserLocationModel();
      await UserLocation.create({
        userId: event.userId,
        userName: event.userName,
        userEmail: event.userEmail,
        role: event.role,
        location: {
          type: 'Point',
          coordinates: [event.longitude, event.latitude],
        },
        latitude: event.latitude,
        longitude: event.longitude,
        accuracy: event.accuracy,
        altitude: event.altitude,
        speed: event.speed,
        heading: event.heading,
        batteryLevel: event.batteryLevel,
        isMocked: event.isMocked || false,
        activity: event.activityType,
        address: event.address,
        timestamp: livePos.lastPingAt,
      });
      persisted = true;
    } catch (err) {
      logger.debug('UserLocation async persistence note:', err);
    }

    return { persisted, insideZones };
  }

  /**
   * Buffer event in memory using sliding window
   */
  private bufferEvent(event: LocationStreamEventOutput): void {
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
    role?: string;
  } = {}): LocationStreamEventOutput[] {
    const limit = Math.min(500, Math.max(1, options.limit || 100));
    let filtered = this.recentEvents;

    if (options.since) {
      const sinceTime = options.since.getTime();
      filtered = filtered.filter((e) => new Date(e.timestamp).getTime() >= sinceTime);
    }

    if (options.role) {
      filtered = filtered.filter((e) => e.role === options.role);
    }

    return filtered.slice(0, limit);
  }

  /**
   * Retrieve active live positions within the last N minutes
   */
  getLiveLocations(options: {
    maxAgeMinutes?: number;
    role?: string;
    limit?: number;
  } = {}): LiveUserPosition[] {
    const maxAgeMinutes = options.maxAgeMinutes || env.LIVE_LOCATION_EXPIRY_MINUTES;
    const cutoffTime = Date.now() - maxAgeMinutes * 60 * 1000;
    const limit = options.limit || 100;

    const results: LiveUserPosition[] = [];

    for (const pos of this.livePositions.values()) {
      if (pos.lastPingAt.getTime() >= cutoffTime) {
        if (!options.role || pos.role === options.role) {
          results.push(pos);
          if (results.length >= limit) break;
        }
      }
    }

    return results;
  }

  /**
   * Retrieve location breadcrumb history for a given user
   */
  async getUserLocationHistory(
    userId: string,
    options: { since?: Date; limit?: number } = {}
  ): Promise<IUserLocation[]> {
    const UserLocation = getUserLocationModel();
    const filter: Record<string, any> = { userId };

    if (options.since) {
      filter.timestamp = { $gte: options.since };
    }

    const limit = Math.min(1000, options.limit || 100);
    return (await UserLocation.find(filter).sort({ timestamp: -1 }).limit(limit).lean()) as unknown as IUserLocation[];
  }

  /**
   * Query nearby users/partners within a radius using geospatial coordinates
   */
  async getNearbyUsers(options: {
    latitude: number;
    longitude: number;
    radiusMeters?: number;
    role?: string;
    limit?: number;
  }): Promise<{ total: number; results: any[] }> {
    const radiusMeters = options.radiusMeters || 5000;
    const limit = options.limit || 50;

    // First attempt MongoDB $nearSphere aggregation
    try {
      const UserLocation = getUserLocationModel();
      const matchCriteria: Record<string, any> = {};
      if (options.role) matchCriteria.role = options.role;

      // Find recent distinct positions
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      matchCriteria.timestamp = { $gte: oneHourAgo };

      const nearDocs = await UserLocation.aggregate([
        {
          $geoNear: {
            near: { type: 'Point', coordinates: [options.longitude, options.latitude] },
            distanceField: 'distanceMeters',
            maxDistance: radiusMeters,
            spherical: true,
            query: matchCriteria,
          },
        },
        {
          $group: {
            _id: '$userId',
            doc: { $first: '$$ROOT' },
          },
        },
        { $replaceRoot: { newRoot: '$doc' } },
        { $sort: { distanceMeters: 1 } },
        { $limit: limit },
      ]);

      if (nearDocs.length > 0) {
        return {
          total: nearDocs.length,
          results: nearDocs,
        };
      }
    } catch (err) {
      logger.debug('MongoDB $geoNear query fell back to in-memory proximity scan:', err);
    }

    // In-memory proximity fallback from livePositions map
    const memoryResults: any[] = [];
    for (const pos of this.livePositions.values()) {
      if (options.role && pos.role !== options.role) continue;

      const dist = calculateHaversineDistance(
        options.latitude,
        options.longitude,
        pos.latitude,
        pos.longitude
      );

      if (dist <= radiusMeters) {
        memoryResults.push({
          ...pos,
          distanceMeters: Math.round(dist),
        });
      }
    }

    memoryResults.sort((a, b) => a.distanceMeters - b.distanceMeters);

    return {
      total: memoryResults.length,
      results: memoryResults.slice(0, limit),
    };
  }
}

export const locationStreamService = new LocationStreamService();

