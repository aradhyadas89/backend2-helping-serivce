import request from 'supertest';
import { createApp } from '../src/app';
import { env } from '../src/config/env';
import { getProductEventModel } from '../src/models/ProductEvent';

const app = createApp();
const secret = env.ADMIN_SUB_BACKEND_SECRET;

describe('User Behavioral Analysis & Recommendations', () => {
  beforeEach(async () => {
    const ProductEvent = getProductEventModel();

    // Seed events for user_analysis_01
    await ProductEvent.create([
      {
        userId: 'user_analysis_01',
        productId: 'prod_electronics_01',
        category: 'electronics',
        eventType: 'purchase',
        timestamp: new Date(),
      },
      {
        userId: 'user_analysis_01',
        productId: 'prod_electronics_02',
        category: 'electronics',
        eventType: 'cart_add',
        timestamp: new Date(),
      },
      {
        userId: 'user_analysis_01',
        productId: 'prod_books_01',
        category: 'books',
        eventType: 'view',
        timestamp: new Date(),
      },
    ]);
  });

  it('POST /api/v1/analysis/trigger?userId=user_analysis_01 should calculate and sync instructions', async () => {
    const res = await request(app)
      .post('/api/v1/analysis/trigger?userId=user_analysis_01')
      .set('x-engine-secret', secret);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.userId).toBe('user_analysis_01');
    expect(res.body.data.boostCategories).toContain('electronics');
  });

  it('GET /api/v1/analysis/users/:userId/profile should return computed profile', async () => {
    // First trigger analysis
    await request(app)
      .post('/api/v1/analysis/trigger?userId=user_analysis_01')
      .set('x-engine-secret', secret);

    const res = await request(app)
      .get('/api/v1/analysis/users/user_analysis_01/profile')
      .set('x-engine-secret', secret);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.userId).toBe('user_analysis_01');
    expect(res.body.data.engineInstructions).toBeDefined();
  });
});

