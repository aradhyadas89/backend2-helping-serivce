import axios, { AxiosInstance } from 'axios';
import { env } from '../config/env';
import { logger } from '../config/logger';
import { SyncUserAnalysisInput } from '../schemas/analysis.schema';

export class MainBackendClientService {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: env.MAIN_BACKEND_URL.replace(/\/+$/, ''),
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'x-engine-secret': env.ANALYSIS_ENGINE_SECRET,
        'x-admin-sub-backend-secret': env.ADMIN_SUB_BACKEND_SECRET,
      },
    });
  }

  /**
   * Push analyzed user instruction vectors & weights back to Helper-FullStack-Backend
   */
  async syncUserAnalysis(payload: SyncUserAnalysisInput): Promise<boolean> {
    try {
      const response = await this.client.post('/api/v1/internal/user-analysis/sync', payload);
      logger.info(`Successfully synced analysis instructions for user ${payload.userId} to Main Backend`);
      return response.status === 200;
    } catch (error: any) {
      logger.warn(
        `Failed to sync analysis instructions to Main Backend (${env.MAIN_BACKEND_URL}): ${error.message}`
      );
      return false;
    }
  }

  /**
   * Fetch interaction telemetry events (views, cart adds, purchases) from Main Backend
   */
  async fetchEventsStream(query: {
    limit?: number;
    since?: Date;
    eventType?: string;
  } = {}): Promise<any[]> {
    try {
      const response = await this.client.get('/api/v1/internal/user-analysis/events', {
        params: {
          limit: query.limit || 500,
          since: query.since?.toISOString(),
          eventType: query.eventType,
        },
      });

      if (response.data && response.data.success && Array.isArray(response.data.data)) {
        return response.data.data;
      }
      return [];
    } catch (error: any) {
      logger.warn(
        `Could not fetch event stream from Main Backend (${env.MAIN_BACKEND_URL}): ${error.message}`
      );
      return [];
    }
  }
}

export const mainBackendClient = new MainBackendClientService();

