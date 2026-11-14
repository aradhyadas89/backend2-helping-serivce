import axios from 'axios';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { calculateHaversineDistance } from '../utils/geo.utils';
import { TransportMode } from '../models/Partner';

export interface RouteComputationResult {
  distanceMeters: number;
  durationSeconds: number;
  polyline?: string;
  source: 'google_maps_api' | 'haversine_fallback';
}

export class GoogleMapsService {
  private apiKey: string;

  constructor() {
    this.apiKey = env.GOOGLE_MAPS_API_KEY || '';
  }

  /**
   * Calculate distance and ETA between origin and destination.
   * Uses Google Routes / Distance Matrix API with automatic fallback to Haversine speed mechanics.
   */
  async calculateRoute(
    origin: { latitude: number; longitude: number },
    destination: { latitude: number; longitude: number },
    mode: TransportMode = 'cycle'
  ): Promise<RouteComputationResult> {
    const travelModeMap = {
      cycle: 'BICYCLE',
      walk: 'WALK',
    };

    // 1. Attempt Google Routes API (Modern Directions v2)
    if (this.apiKey && process.env.NODE_ENV !== 'test') {
      try {
        const response = await axios.post(
          'https://routes.googleapis.com/directions/v2:computeRoutes',
          {
            origin: {
              location: {
                latLng: {
                  latitude: origin.latitude,
                  longitude: origin.longitude,
                },
              },
            },
            destination: {
              location: {
                latLng: {
                  latitude: destination.latitude,
                  longitude: destination.longitude,
                },
              },
            },
            travelMode: travelModeMap[mode] || 'BICYCLE',
          },
          {
            headers: {
              'Content-Type': 'application/json',
              'X-Goog-Api-Key': this.apiKey,
              'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline',
            },
            timeout: 3500, // 3.5s timeout for fast response
          }
        );

        const route = response.data.routes?.[0];
        if (route) {
          const distanceMeters = route.distanceMeters || 0;
          // Duration format from Google Routes is e.g. "450s"
          const durationSeconds = route.duration ? parseInt(route.duration.replace('s', ''), 10) : 0;
          const polyline = route.polyline?.encodedPolyline;

          logger.debug(`[GOOGLE MAPS] Route computed: ${distanceMeters}m in ${durationSeconds}s`);
          return {
            distanceMeters,
            durationSeconds,
            polyline,
            source: 'google_maps_api',
          };
        }
      } catch (err: any) {
        logger.debug(
          `[GOOGLE MAPS] API route call fell back to Haversine: ${err.response?.data?.error?.message || err.message}`
        );
      }
    }

    // 2. High-Precision Haversine Fallback Engine
    const distanceMeters = Math.round(
      calculateHaversineDistance(
        origin.latitude,
        origin.longitude,
        destination.latitude,
        destination.longitude
      )
    );

    // Speed: cycle = 15 km/h (~4.167 m/s), walk = 4.5 km/h (1.25 m/s)
    const speedMps = mode === 'walk' ? 1.25 : 4.167;
    const durationSeconds = Math.max(30, Math.round(distanceMeters / speedMps));

    return {
      distanceMeters,
      durationSeconds,
      source: 'haversine_fallback',
    };
  }

  /**
   * Reverse geocode a latitude & longitude into a human-readable address
   */
  async reverseGeocode(latitude: number, longitude: number): Promise<string> {
    if (this.apiKey && process.env.NODE_ENV !== 'test') {
      try {
        const response = await axios.get(
          `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latitude},${longitude}&key=${this.apiKey}`,
          { timeout: 3000 }
        );
        if (response.data.results && response.data.results.length > 0) {
          return response.data.results[0].formatted_address;
        }
      } catch (err: any) {
        logger.debug(`[GOOGLE MAPS] Geocoding fallback: ${err.message}`);
      }
    }

    return `Coordinates: ${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
  }

  /**
   * Geocode an address into latitude & longitude coordinates
   */
  async geocodeAddress(address: string): Promise<{ latitude: number; longitude: number } | null> {
    if (this.apiKey && process.env.NODE_ENV !== 'test') {
      try {
        const response = await axios.get(
          `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${this.apiKey}`,
          { timeout: 3000 }
        );
        if (response.data.results && response.data.results.length > 0) {
          const loc = response.data.results[0].geometry.location;
          return { latitude: loc.lat, longitude: loc.lng };
        }
      } catch (err: any) {
        logger.debug(`[GOOGLE MAPS] Address geocode failed: ${err.message}`);
      }
    }
    return null;
  }
}

export const googleMapsService = new GoogleMapsService();
