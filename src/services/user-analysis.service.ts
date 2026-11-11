import {
  getUserInterestProfileModel,
  IUserInterestProfile,
} from '../models/UserInterestProfile';
import { getProductEventModel, IProductEvent } from '../models/ProductEvent';
import { SyncUserAnalysisInput } from '../schemas/analysis.schema';
import { mainBackendClient } from './main-backend-client.service';
import { logger } from '../config/logger';
import { env } from '../config/env';

export class UserAnalysisService {
  private workerTimer: NodeJS.Timeout | null = null;

  /**
   * Run behavioral intelligence analysis for a single user
   */
  async analyzeUser(userId: string): Promise<SyncUserAnalysisInput> {
    const ProductEvent = getProductEventModel();

    // 1. Fetch user interaction events
    const events: IProductEvent[] = (await ProductEvent.find({ userId })
      .sort({ timestamp: -1 })
      .limit(500)
      .lean()) as unknown as IProductEvent[];

    // 2. Compute category weights based on interaction hierarchy
    // purchase: +25, cart_add: +15, accessory_click: +10, view: +3, cart_remove: -10
    const categoryScores: Record<string, number> = {};
    const tagScores: Record<string, number> = {};
    const segments: Set<string> = new Set();

    let viewCount = 0;
    let cartAddCount = 0;
    let purchaseCount = 0;

    for (const e of events) {
      const cat = e.category;
      if (!cat) continue;

      let weightDelta = 0;
      switch (e.eventType) {
        case 'purchase':
          weightDelta = 25;
          purchaseCount++;
          break;
        case 'cart_add':
          weightDelta = 15;
          cartAddCount++;
          break;
        case 'accessory_click':
          weightDelta = 10;
          break;
        case 'view':
          weightDelta = 3;
          viewCount++;
          break;
        case 'cart_remove':
          weightDelta = -10;
          break;
      }

      categoryScores[cat] = (categoryScores[cat] || 0) + weightDelta;

      // Process tags in metadata if available
      if (e.metadata?.tags && Array.isArray(e.metadata.tags)) {
        for (const tag of e.metadata.tags) {
          tagScores[tag] = (tagScores[tag] || 0) + Math.max(1, Math.round(weightDelta / 2));
        }
      }
    }

    // 3. User Segmentation Logic
    if (purchaseCount >= 3) {
      segments.add('frequent_shopper');
    }
    if (cartAddCount > 2 && purchaseCount === 0) {
      segments.add('high_intent_hesitant');
    }
    if (viewCount > 15 && cartAddCount === 0) {
      segments.add('active_browser');
    }
    if (events.length > 30) {
      segments.add('power_user');
    }

    // 4. Rank category affinities (normalize between 0 and 100)
    const sortedCategories = Object.entries(categoryScores).sort((a, b) => b[1] - a[1]);

    const maxScore = sortedCategories.length > 0 ? Math.max(1, sortedCategories[0][1]) : 1;
    const categoryAffinities = sortedCategories.map(([category, rawScore]) => ({
      category,
      weight: Math.min(100, Math.max(0, Math.round((rawScore / maxScore) * 100))),
    }));

    // Boost top 3 categories with positive affinity
    const boostCategories = categoryAffinities
      .filter((ca) => ca.weight >= 40)
      .slice(0, 3)
      .map((ca) => ca.category);

    // Suppress categories with negative or very low score
    const suppressCategories = sortedCategories
      .filter(([_cat, score]) => score < 0)
      .map(([cat]) => cat);

    // Rank tag weights
    const sortedTags = Object.entries(tagScores).sort((a, b) => b[1] - a[1]);
    const maxTagScore = sortedTags.length > 0 ? Math.max(1, sortedTags[0][1]) : 1;
    const tagWeights = sortedTags.slice(0, 10).map(([tag, score]) => ({
      tag,
      weight: Math.min(100, Math.max(0, Math.round((score / maxTagScore) * 100))),
    }));

    const analysisResult: SyncUserAnalysisInput = {
      userId,
      segments: Array.from(segments),
      boostCategories,
      suppressCategories,
      preferredPriceTier: 'mid',
      customWeights: {
        academicAlignmentBonus: 25,
        cartDwellBonus: 30,
        popularityWeight: 10,
      },
      categoryAffinities,
      tagWeights,
    };

    // 5. Update local UserInterestProfile document
    const UserInterestProfile = getUserInterestProfileModel();
    await UserInterestProfile.findOneAndUpdate(
      { userId },
      {
        $set: {
          categoryAffinities: categoryAffinities.map((ca) => ({
            category: ca.category,
            weight: ca.weight,
            lastInteractedAt: new Date(),
          })),
          tagWeights,
          'engineInstructions.segments': analysisResult.segments,
          'engineInstructions.boostCategories': analysisResult.boostCategories,
          'engineInstructions.suppressCategories': analysisResult.suppressCategories,
          'engineInstructions.preferredPriceTier': analysisResult.preferredPriceTier,
          'engineInstructions.customWeights': analysisResult.customWeights,
          'engineInstructions.updatedAt': new Date(),
          lastCalculatedAt: new Date(),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // 6. Push updated instructions to Main Backend
    await mainBackendClient.syncUserAnalysis(analysisResult);

    return analysisResult;
  }

  /**
   * Run batch analysis across active users
   */
  async runBatchAnalysis(): Promise<{ processedUsers: number }> {
    logger.info('Starting scheduled User Behavioral Intelligence batch run...');
    const ProductEvent = getProductEventModel();

    // Distinct users with interactions in the last 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const userIds = await ProductEvent.distinct('userId', { timestamp: { $gte: sevenDaysAgo } });

    logger.info(`Found ${userIds.length} active users for recommendation tuning`);

    let processed = 0;
    for (const userId of userIds) {
      try {
        await this.analyzeUser(userId);
        processed++;
      } catch (err) {
        logger.error(`Failed to analyze user ${userId}:`, err);
      }
    }

    logger.info(`Completed User Behavioral Intelligence run. Processed ${processed} users.`);
    return { processedUsers: processed };
  }

  /**
   * Start recurring background analysis worker
   */
  startAutoWorker(): void {
    if (this.workerTimer) return;
    const interval = env.AUTO_ANALYSIS_WORKER_INTERVAL_MS;

    logger.info(`Auto-Analysis Worker scheduled to trigger every ${Math.round(interval / 1000)}s`);

    this.workerTimer = setInterval(async () => {
      try {
        await this.runBatchAnalysis();
      } catch (err) {
        logger.error('Error during scheduled auto-analysis run:', err);
      }
    }, interval);
  }

  /**
   * Stop background worker cleanly
   */
  stopAutoWorker(): void {
    if (this.workerTimer) {
      clearInterval(this.workerTimer);
      this.workerTimer = null;
      logger.info('Stopped Auto-Analysis Worker');
    }
  }
}

export const userAnalysisService = new UserAnalysisService();

