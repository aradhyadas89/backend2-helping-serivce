import { Router, Request, Response, NextFunction } from 'express';
import { requireInternalOrAdmin } from '../middlewares/auth.middleware';
import { validateQuery } from '../middlewares/validate';
import { triggerAnalysisQuerySchema } from '../schemas/analysis.schema';
import { userAnalysisService } from '../services/user-analysis.service';
import { getUserInterestProfileModel } from '../models/UserInterestProfile';
import { sendSuccess } from '../utils/response.utils';
import { NotFoundException } from '../middlewares/errorHandler';

const router = Router();

router.use(requireInternalOrAdmin);

/**
 * @route   POST /api/v1/analysis/trigger
 * @desc    Trigger behavioral analysis and recommendation tuning (single user or batch)
 */
router.post(
  '/trigger',
  validateQuery(triggerAnalysisQuerySchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { userId } = req.query as any;

      if (userId) {
        const result = await userAnalysisService.analyzeUser(userId);
        return sendSuccess(res, result, `Analysis completed for user ${userId}`);
      }

      const batchResult = await userAnalysisService.runBatchAnalysis();
      return sendSuccess(
        res,
        batchResult,
        `Batch analysis completed for ${batchResult.processedUsers} users`
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/v1/analysis/users/:userId/profile
 * @desc    View computed interest profile & engine instructions for a user
 */
router.get(
  '/users/:userId/profile',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const UserInterestProfile = getUserInterestProfileModel();
      const profile = await UserInterestProfile.findOne({ userId: req.params.userId }).lean();

      if (!profile) {
        throw new NotFoundException(`User interest profile for ${req.params.userId} not found`);
      }

      return sendSuccess(res, profile, 'User interest profile retrieved successfully');
    } catch (error) {
      next(error);
    }
  }
);

export default router;

