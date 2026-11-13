import { Router, Request, Response, NextFunction } from 'express';
import { getProductModel } from '../models/Product';
import { sendSuccess } from '../utils/response.utils';
import { NotFoundException } from '../middlewares/errorHandler';

const router = Router();

/**
 * @route   GET /api/v1/products
 * @desc    List active products with category and search filter
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { category, search, limit = '50', page = '1' } = req.query as any;
    const Product = getProductModel();
    const filter: Record<string, any> = { isActive: true, isDeleted: false };

    if (category) filter.category = category;
    if (search) {
      filter.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
        { tags: { $in: [new RegExp(search, 'i')] } },
      ];
    }

    const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10)));
    const pageNum = Math.max(1, parseInt(page, 10));
    const skip = (pageNum - 1) * limitNum;

    const [products, total] = await Promise.all([
      Product.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
      Product.countDocuments(filter),
    ]);

    return sendSuccess(res, products, 'Products retrieved successfully', 200, {
      total,
      count: products.length,
      meta: { page: pageNum, totalPages: Math.ceil(total / limitNum) || 1 },
    });
  } catch (error) {
    next(error);
  }
});

/**
 * @route   GET /api/v1/products/:productId
 * @desc    Get product details, pricing, discount, and stock
 */
router.get('/:productId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const Product = getProductModel();
    const product = await Product.findOne({
      _id: req.params.productId,
      isActive: true,
      isDeleted: false,
    }).lean();

    if (!product) {
      throw new NotFoundException(`Product ${req.params.productId} not found`);
    }

    return sendSuccess(res, product, 'Product details retrieved successfully');
  } catch (error) {
    next(error);
  }
});

/**
 * @route   POST /api/v1/products
 * @desc    Admin upload product to catalog
 */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const Product = getProductModel();
    const slug = req.body.slug || req.body.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const sku = req.body.sku || `SKU-${Date.now()}`;

    const product = await Product.create({
      ...req.body,
      slug,
      sku,
    });

    return sendSuccess(res, product, 'Product listed in catalog successfully', 201);
  } catch (error) {
    next(error);
  }
});

/**
 * @route   PATCH /api/v1/products/:productId
 * @desc    Admin update product pricing, discount, or stock
 */
router.patch('/:productId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const Product = getProductModel();
    const updated = await Product.findByIdAndUpdate(
      req.params.productId,
      { $set: req.body },
      { new: true }
    );

    if (!updated) {
      throw new NotFoundException(`Product ${req.params.productId} not found`);
    }

    return sendSuccess(res, updated, 'Product updated successfully');
  } catch (error) {
    next(error);
  }
});

export default router;

