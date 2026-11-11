import { getGeofenceZoneModel, IGeofenceZone } from '../models/GeofenceZone';
import { CreateGeofenceInput } from '../schemas/location.schema';
import { isPointInCircle, isPointInPolygon } from '../utils/geo.utils';
import { alertService } from './alert.service';
import { logger } from '../config/logger';

export class GeofenceService {
  private activeZonesCache: IGeofenceZone[] = [];
  private lastCacheRefresh: number = 0;
  private readonly cacheTTL = 60000; // 1 minute

  /**
   * Fetch active geofences with memory caching
   */
  async getActiveZones(): Promise<IGeofenceZone[]> {
    const now = Date.now();
    if (this.activeZonesCache.length > 0 && now - this.lastCacheRefresh < this.cacheTTL) {
      return this.activeZonesCache;
    }

    try {
      const GeofenceZone = getGeofenceZoneModel();
      this.activeZonesCache = (await GeofenceZone.find({ isActive: true }).lean()) as unknown as IGeofenceZone[];
      this.lastCacheRefresh = now;
    } catch (err) {
      logger.error('Error fetching active geofences:', err);
    }

    return this.activeZonesCache;
  }

  /**
   * Create a new geofence zone
   */
  async createGeofence(input: CreateGeofenceInput): Promise<IGeofenceZone> {
    const GeofenceZone = getGeofenceZoneModel();

    const payload: Record<string, any> = {
      name: input.name,
      code: input.code.toUpperCase(),
      description: input.description,
      shape: input.shape,
      category: input.category,
      isActive: input.isActive,
      alertOnExit: input.alertOnExit,
      alertOnEntry: input.alertOnEntry,
    };

    if (input.shape === 'circle') {
      if (!input.center || !input.radiusMeters) {
        throw new Error('Center coordinates and radiusMeters required for circular geofences');
      }
      payload.center = {
        type: 'Point',
        coordinates: [input.center.longitude, input.center.latitude],
      };
      payload.radiusMeters = input.radiusMeters;
    } else if (input.shape === 'polygon') {
      if (!input.polygonCoordinates || input.polygonCoordinates.length < 3) {
        throw new Error('Polygon geofences require at least 3 coordinates');
      }
      // Ensure polygon is closed (first and last coordinate match)
      const coords = [...input.polygonCoordinates];
      const first = coords[0];
      const last = coords[coords.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) {
        coords.push(first);
      }
      payload.geometry = {
        type: 'Polygon',
        coordinates: [coords],
      };
    }

    const zone = await GeofenceZone.create(payload);
    // Invalidate cache
    this.lastCacheRefresh = 0;
    return zone;
  }

  /**
   * Check if a coordinate is inside any active geofence zones, and trigger breach alerts if configured
   */
  async evaluateLocation(event: {
    userId: string;
    userName?: string;
    userEmail?: string;
    role: 'user' | 'partner' | 'admin';
    latitude: number;
    longitude: number;
  }): Promise<{ insideZones: string[] }> {
    const zones = await this.getActiveZones();
    const insideZones: string[] = [];

    for (const zone of zones) {
      let isInside = false;

      if (zone.shape === 'circle' && zone.center && zone.radiusMeters) {
        const [centerLon, centerLat] = zone.center.coordinates;
        isInside = isPointInCircle(
          event.latitude,
          event.longitude,
          centerLat,
          centerLon,
          zone.radiusMeters
        );
      } else if (zone.shape === 'polygon' && zone.geometry?.coordinates?.[0]) {
        isInside = isPointInPolygon(
          event.longitude,
          event.latitude,
          zone.geometry.coordinates[0]
        );
      }

      if (isInside) {
        insideZones.push(zone.code);

        if (zone.alertOnEntry) {
          await alertService.createAlert({
            alertType: 'geofence_breach',
            severity: 'medium',
            userId: event.userId,
            userName: event.userName,
            userEmail: event.userEmail,
            role: event.role,
            title: `Entered Geofence Zone: ${zone.name}`,
            description: `User ${event.userName || event.userId} entered geofence boundary '${zone.name}' (${zone.code}).`,
            metadata: { zoneCode: zone.code, zoneName: zone.name, eventType: 'entry' },
            location: { latitude: event.latitude, longitude: event.longitude },
          });
        }
      }
    }

    return { insideZones };
  }
}

export const geofenceService = new GeofenceService();

