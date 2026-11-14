import { Router, Request, Response, NextFunction } from 'express';
import { validateBody } from '../middlewares/validate';
import {
  registerPartnerSchema,
  loginPartnerSchema,
  togglePartnerOnlineSchema,
  partnerUpdateLocationSchema,
} from '../schemas/partner.schema';
import { getPartnerModel } from '../models/Partner';
import { getPartnerWalletModel } from '../models/PartnerWallet';
import { partnerDispatchService } from '../services/partner-dispatch.service';
import { partnerAnalysisService } from '../services/partner-analysis.service';
import { hashPassword, verifyPassword, generatePartnerToken } from '../utils/auth.utils';
import { sendSuccess } from '../utils/response.utils';
import {
  NotFoundException,
  ConflictException,
  UnauthorizedException,
} from '../middlewares/errorHandler';

const router = Router();

/**
 * @route   POST /api/v1/partners/register
 * @desc    Register a new delivery partner with authentication credentials
 */
router.post(
  '/register',
  validateBody(registerPartnerSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const Partner = getPartnerModel();
      const PartnerWallet = getPartnerWalletModel();

      const partnerId = req.body.partnerId || `PTR-${Date.now()}`;
      const existing = await Partner.findOne({ $or: [{ email: req.body.email }, { partnerId }] });

      if (existing) {
        throw new ConflictException('Partner with this email or partnerId already exists');
      }

      const passwordHash = hashPassword(req.body.password || 'Partner@123');

      const partner = await Partner.create({
        partnerId,
        name: req.body.name,
        email: req.body.email,
        phone: req.body.phone,
        passwordHash,
        transportMode: req.body.transportMode || 'cycle',
        isOnline: false,
      });

      // Initialize virtual wallet
      await PartnerWallet.create({
        partnerId,
        virtualBalance: 0.0,
        totalEarned: 0.0,
      });

      const token = generatePartnerToken({
        partnerId: partner.partnerId,
        email: partner.email,
        name: partner.name,
      });

      return sendSuccess(
        res,
        {
          partner,
          token,
        },
        'Partner registered and authenticated successfully',
        201
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   POST /api/v1/partners/login
 * @desc    Partner login with email and password -> returns JWT token
 */
router.post(
  '/login',
  validateBody(loginPartnerSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, password } = req.body;
      const Partner = getPartnerModel();

      const partner = await Partner.findOne({ email }).select('+passwordHash');
      if (!partner) {
        throw new UnauthorizedException('Invalid email or password');
      }

      if (partner.isBlocked) {
        throw new UnauthorizedException('Partner account is suspended. Contact fleet dispatch.');
      }

      if (partner.passwordHash && !verifyPassword(password, partner.passwordHash)) {
        throw new UnauthorizedException('Invalid email or password');
      }

      partner.lastLoginAt = new Date();
      await partner.save();

      const token = generatePartnerToken({
        partnerId: partner.partnerId,
        email: partner.email,
        name: partner.name,
      });

      return sendSuccess(
        res,
        {
          partner,
          token,
        },
        'Partner logged in successfully'
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/v1/partners
 * @desc    List delivery partners (filter by online state, transport mode)
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { isOnline, transportMode, limit = '50', page = '1' } = req.query as any;
    const Partner = getPartnerModel();
    const filter: Record<string, any> = {};

    if (isOnline !== undefined) filter.isOnline = isOnline === 'true';
    if (transportMode) filter.transportMode = transportMode;

    const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10)));
    const pageNum = Math.max(1, parseInt(page, 10));
    const skip = (pageNum - 1) * limitNum;

    const [partners, total] = await Promise.all([
      Partner.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
      Partner.countDocuments(filter),
    ]);

    return sendSuccess(res, partners, 'Partners retrieved successfully', 200, {
      total,
      count: partners.length,
      meta: { page: pageNum, totalPages: Math.ceil(total / limitNum) || 1 },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/v1/partners/:partnerId/toggle-online
 * @desc    Toggle partner online/offline state with current GPS coordinate
 */
router.post(
  '/:partnerId/toggle-online',
  validateBody(togglePartnerOnlineSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const Partner = getPartnerModel();
      const { isOnline, latitude, longitude } = req.body;

      const partner = await Partner.findOneAndUpdate(
        { partnerId: req.params.partnerId },
        {
          $set: {
            isOnline,
            latitude,
            longitude,
            currentLocation: {
              type: 'Point',
              coordinates: [longitude, latitude],
            },
            lastLocationUpdate: new Date(),
          },
        },
        { new: true }
      );

      if (!partner) {
        throw new NotFoundException(`Partner ${req.params.partnerId} not found`);
      }

      return sendSuccess(
        res,
        partner,
        `Partner is now ${isOnline ? 'ONLINE' : 'OFFLINE'}`
      );
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/v1/partners/:partnerId/profile
 * @desc    View partner profile, rating, reputation, and 5:1 ratio balance
 */
router.get('/:partnerId/profile', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const Partner = getPartnerModel();
    const partner = await Partner.findOne({ partnerId: req.params.partnerId }).lean();

    if (!partner) {
      throw new NotFoundException(`Partner ${req.params.partnerId} not found`);
    }

    const ratioStatus = await partnerDispatchService.checkPartnerOfflineRatioEligibility(
      req.params.partnerId
    );

    return sendSuccess(
      res,
      {
        ...partner,
        paymentModeRatioStatus: ratioStatus,
      },
      'Partner profile retrieved successfully'
    );
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/v1/partners/:partnerId/behaviour-analysis
 * @desc    Evaluate partner behavioral metrics, punctuality, and reliability tier
 */
router.get(
  '/:partnerId/behaviour-analysis',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const report = await partnerAnalysisService.analyzePartnerBehaviour(req.params.partnerId);
      return sendSuccess(res, report, 'Partner behavioural analysis computed successfully');
    } catch (error) {
      next(error);
    }
  }
);

/**
 * @route   GET /api/v1/partners/:partnerId/wallet
 * @desc    View partner virtual in-app earnings wallet
 */
router.get('/:partnerId/wallet', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const PartnerWallet = getPartnerWalletModel();
    const wallet = await PartnerWallet.findOne({ partnerId: req.params.partnerId }).lean();

    if (!wallet) {
      throw new NotFoundException(`Wallet for partner ${req.params.partnerId} not found`);
    }

    return sendSuccess(res, wallet, 'Partner virtual wallet retrieved successfully');
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/v1/partners/:partnerId/location
 * @desc    Update partner real-time GPS coordinate
 */
router.post(
  '/:partnerId/location',
  validateBody(partnerUpdateLocationSchema),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const Partner = getPartnerModel();
      const { latitude, longitude } = req.body;

      const partner = await Partner.findOneAndUpdate(
        { partnerId: req.params.partnerId },
        {
          $set: {
            latitude,
            longitude,
            currentLocation: {
              type: 'Point',
              coordinates: [longitude, latitude],
            },
            lastLocationUpdate: new Date(),
          },
        },
        { new: true }
      );

      if (!partner) {
        throw new NotFoundException(`Partner ${req.params.partnerId} not found`);
      }

      return sendSuccess(
        res,
        { partnerId: partner.partnerId, latitude, longitude },
        'Partner location updated'
      );
    } catch (error) {
      next(error);
    }
  }
);

export default router;
