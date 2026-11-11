import { Router, Request, Response, NextFunction } from 'express';
import { validateBody } from '../middlewares/validate';
import {
  registerPartnerSchema,
  togglePartnerOnlineSchema,
  partnerUpdateLocationSchema,
} from '../schemas/partner.schema';
import { getPartnerModel } from '../models/Partner';
import { getPartnerWalletModel } from '../models/PartnerWallet';
import { partnerDispatchService } from '../services/partner-dispatch.service';
import { sendSuccess } from '../utils/response.utils';
import { NotFoundException, ConflictException } from '../middlewares/errorHandler';

const router = Router();

/**
 * @route   POST /api/v1/partners/register
 * @desc    Register a new delivery partner
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

      const partner = await Partner.create({
        partnerId,
        name: req.body.name,
        email: req.body.email,
        phone: req.body.phone,
        transportMode: req.body.transportMode || 'cycle',
        isOnline: false,
      });

      // Initialize virtual wallet
      await PartnerWallet.create({
        partnerId,
        virtualBalance: 0.0,
        totalEarned: 0.0,
      });

      return sendSuccess(res, partner, 'Partner registered successfully', 201);
    } catch (error) {
      next(error);
    }
  }
);

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

    return sendSuccess(res, {
      ...partner,
      paymentModeRatioStatus: ratioStatus,
    }, 'Partner profile retrieved successfully');
  } catch (error) {
    next(error);
  }
});

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

      return sendSuccess(res, { partnerId: partner.partnerId, latitude, longitude }, 'Partner location updated');
    } catch (error) {
      next(error);
    }
  }
);

export default router;
