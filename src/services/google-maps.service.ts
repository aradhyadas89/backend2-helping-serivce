import axios from 'axios';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { calculateHaversineDistance } from '../utils/geo.utils';
import { TransportMode } from '../models/Partner';

export interface RouteComputationResult {
  distanceMeters: number;
  durationSeconds: number;
  polyline?: string;
  source: 'mappls_api' | 'google_maps_api' | 'haversine_fallback';
}

export class GoogleMapsService {
  private googleApiKey: string;
  private mapplsApiKey: string;

  constructor() {
    this.googleApiKey = env.GOOGLE_MAPS_API_KEY || '';
    this.mapplsApiKey = env.MAPPLS_API_KEY || '';
  }

  /**
   * Calculate distance and ETA between origin and destination.
   * Cascade: Mappls (MapmyIndia) -> Google Routes API -> High-precision Haversine fallback.
   */
  async calculateRoute(
    origin: { latitude: number; longitude: number },
    destination: { latitude: number; longitude: number },
    mode: TransportMode = 'cycle'
  ): Promise<RouteComputationResult> {
    // 1. Attempt Mappls (MapmyIndia) Distance Matrix / Route API
    if (this.mapplsApiKey && process.env.NODE_ENV !== 'test') {
      try {
        const mapplsMode = mode === 'walk' ? 'walking' : 'biking';
        const url = `https://apis.mappls.com/advancedmaps/v1/${this.mapplsApiKey}/distance_matrix/${mapplsMode}/${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}`;

        const response = await axios.get(url, { timeout: 3500 });
        if (response.data?.results?.distances?.[0]?.[1] !== undefined) {
          const distanceMeters = Math.round(response.data.results.distances[0][1]);
          const durationSeconds = Math.round(response.data.results.durations[0][1] || 0);

          logger.debug(`[MAPPLS] Route computed: ${distanceMeters}m in ${durationSeconds}s`);
          return {
            distanceMeters,
            durationSeconds,
            source: 'mappls_api',
          };
        }
      } catch (err: any) {
        logger.debug(
          `[MAPPLS] API call fell back to secondary provider: ${err.response?.data?.msg || err.message}`
        );
      }
    }

    // 2. Attempt Google Routes API (Modern Directions v2)
    const travelModeMap = {
      cycle: 'BICYCLE',
      walk: 'WALK',
    };

    if (this.googleApiKey && process.env.NODE_ENV !== 'test') {
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
              'X-Goog-Api-Key': this.googleApiKey,
              'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline',
            },
            timeout: 3500,
          }
        );

        const route = response.data.routes?.[0];
        if (route) {
          const distanceMeters = route.distanceMeters || 0;
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

    // 3. High-Precision Haversine Fallback Engine
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
   * Reverse geocode coordinates into a human-readable street address
   * Cascade: Mappls -> Google Geocode -> Formatted Coordinates
   */
  async reverseGeocode(latitude: number, longitude: number): Promise<string> {
    // 1. Mappls Rev Geocode
    if (this.mapplsApiKey && process.env.NODE_ENV !== 'test') {
      try {
        const response = await axios.get(
          `https://apis.mappls.com/advancedmaps/v1/${this.mapplsApiKey}/rev_geocode?lat=${latitude}&lng=${longitude}`,
          { timeout: 3000 }
        );
        if (response.data?.results?.[0]?.formatted_address) {
          return response.data.results[0].formatted_address;
        }
      } catch (err: any) {
        logger.debug(`[MAPPLS] Reverse geocode fallback: ${err.message}`);
      }
    }

    // 2. Google Geocode
    if (this.googleApiKey && process.env.NODE_ENV !== 'test') {
      try {
        const response = await axios.get(
          `https://maps.googleapis.com/maps/api/geocode/json?latlng=${latitude},${longitude}&key=${this.googleApiKey}`,
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
    if (this.googleApiKey && process.env.NODE_ENV !== 'test') {
      try {
        const response = await axios.get(
          `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${this.googleApiKey}`,
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
