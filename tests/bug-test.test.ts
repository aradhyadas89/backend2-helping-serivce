import request from 'supertest';
import { createApp } from '../src/app';
import { getProductModel } from '../src/models/Product';
import { getPartnerModel } from '../src/models/Partner';
import { getPartnerWalletModel } from '../src/models/PartnerWallet';
import { getUserOrderProfileModel } from '../src/models/UserOrderProfile';
import { getOrderModel } from '../src/models/Order';
import { orderService } from '../src/services/order.service';

const app = createApp();

describe('Comprehensive Bug Test Suite: Multi-DB Sub-Backend Edge Cases', () => {
  let prodNotebookId: string;
  let prodPenId: string;
  let partner1Id = 'PTR-BUG-01';
  let partner2Id = 'PTR-BUG-02';

  beforeEach(async () => {
    const Product = getProductModel();
    const Partner = getPartnerModel();

    // 1. Seed Products
    const notebook = await Product.create({
      title: 'Classmate Spiral Notebook',
      slug: `notebook-${Date.now()}-${Math.random()}`,
      description: '200 pages ruled spiral notebook',
      category: 'stationery',
      sku: `SKU-NB-${Date.now()}-${Math.random()}`,
      price: 60.0,
      stock: 50,
      isActive: true,
      isDeleted: false,
    });
    prodNotebookId = notebook._id.toString();

    const pen = await Product.create({
      title: 'Reynolds Gel Pen',
      slug: `pen-${Date.now()}-${Math.random()}`,
      description: 'Blue ink gel pen',
      category: 'stationery',
      sku: `SKU-PEN-${Date.now()}-${Math.random()}`,
      price: 10.0,
      stock: 100,
      isActive: true,
      isDeleted: false,
    });
    prodPenId = pen._id.toString();

    // 2. Seed 2 Online Partners (within 2.5 km zone)
    await Partner.create([
      {
        partnerId: partner1Id,
        name: 'Amit Kumar',
        email: `amit-${Date.now()}@example.com`,
        phone: '9876543211',
        isOnline: true,
        transportMode: 'cycle',
        latitude: 22.574,
        longitude: 88.365,
        currentLocation: { type: 'Point', coordinates: [88.365, 22.574] },
      },
      {
        partnerId: partner2Id,
        name: 'Rohan Sen',
        email: `rohan-${Date.now()}@example.com`,
        phone: '9876543212',
        isOnline: true,
        transportMode: 'walk',
        latitude: 22.579,
        longitude: 88.368,
        currentLocation: { type: 'Point', coordinates: [88.368, 22.579] },
      },
    ]);
  });

  describe('Bug Test 1: Minimum ₹30 Order Value Boundary & Pre-Order Bill Preview', () => {
    it('should reject order if subtotal < ₹30 with 400 Bad Request', async () => {
      // 2 pens @ ₹10 = ₹20 (< ₹30)
      const res = await request(app)
        .post('/api/v1/orders')
        .send({
          userId: 'user_boundary_01',
          items: [{ productId: prodPenId, quantity: 2 }],
          latitude: 22.5726,
          longitude: 88.3639,
          deliveryAddress: 'Park Street, Kolkata',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('Minimum order value is ₹30.00');
    });

    it('should accurately calculate bill preview and indicate shortfall without throwing error', async () => {
      // 2 pens @ ₹10 = ₹20
      const previewRes = await request(app)
        .post('/api/v1/orders/calculate-bill')
        .send({
          userId: 'user_boundary_01',
          items: [{ productId: prodPenId, quantity: 2 }],
          approxDistanceMeters: 1000,
        });

      expect(previewRes.status).toBe(200);
      expect(previewRes.body.data.subtotal).toBe(20.0);
      expect(previewRes.body.data.canOrder).toBe(false);
      expect(previewRes.body.data.amountShort).toBe(10.0);
      expect(previewRes.body.data.deliveryFee).toBe(15.0);
    });

    it('should accept order if subtotal exactly matches ₹30 (3 pens @ ₹10)', async () => {
      const res = await request(app)
        .post('/api/v1/orders')
        .send({
          userId: 'user_boundary_02',
          items: [{ productId: prodPenId, quantity: 3 }],
          latitude: 22.5726,
          longitude: 88.3639,
          deliveryAddress: 'Park Street, Kolkata',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.subtotal).toBe(30.0);
    });
  });

  describe('Bug Test 2: Partner Crisis Gate (< 2 Online Partners in 2.5km Zone)', () => {
    it('should return 503 when only 1 partner is online in the 2.5km radius', async () => {
      const Partner = getPartnerModel();
      // Set partner2 offline
      await Partner.updateOne({ partnerId: partner2Id }, { $set: { isOnline: false } });

      const res = await request(app)
        .post('/api/v1/orders')
        .send({
          userId: 'user_crisis_01',
          items: [{ productId: prodNotebookId, quantity: 1 }],
          latitude: 22.5726,
          longitude: 88.3639,
          deliveryAddress: 'Esplanade, Kolkata',
        });

      expect(res.status).toBe(503);
      expect(res.body.error.message).toContain('partner crisis');
    });

    it('should succeed once second partner toggles back online', async () => {
      const Partner = getPartnerModel();
      await Partner.updateOne({ partnerId: partner2Id }, { $set: { isOnline: false } });

      // Partner toggles online
      const toggleRes = await request(app)
        .post(`/api/v1/partners/${partner2Id}/toggle-online`)
        .send({
          isOnline: true,
          latitude: 22.5726,
          longitude: 88.3639,
        });

      expect(toggleRes.status).toBe(200);
      expect(toggleRes.body.data.isOnline).toBe(true);

      // Now placing order succeeds
      const orderRes = await request(app)
        .post('/api/v1/orders')
        .send({
          userId: 'user_crisis_02',
          items: [{ productId: prodNotebookId, quantity: 1 }],
          latitude: 22.5726,
          longitude: 88.3639,
          deliveryAddress: 'Esplanade, Kolkata',
        });

      expect(orderRes.status).toBe(201);
    });
  });

  describe('Bug Test 3: Race Condition & Atomic First-Pick Protection', () => {
    it('should allow first partner to claim order and reject concurrent claim with 409 Conflict', async () => {
      const orderRes = await request(app)
        .post('/api/v1/orders')
        .send({
          userId: 'user_race_01',
          items: [{ productId: prodNotebookId, quantity: 1 }],
          latitude: 22.5726,
          longitude: 88.3639,
          deliveryAddress: 'Salt Lake Sector V, Kolkata',
        });

      const orderId = orderRes.body.data.orderId;

      // Both partners attempt to claim order concurrently
      const [claim1, claim2] = await Promise.all([
        request(app).post(`/api/v1/orders/${orderId}/partner-accept`).send({ partnerId: partner1Id }),
        request(app).post(`/api/v1/orders/${orderId}/partner-accept`).send({ partnerId: partner2Id }),
      ]);

      const statuses = [claim1.status, claim2.status].sort();
      expect(statuses).toEqual([200, 409]);

      const conflictRes = claim1.status === 409 ? claim1 : claim2;
      expect(conflictRes.body.error.message).toContain('already been picked up');
    });
  });

  describe('Bug Test 4: 1-Minute Payment Timeout Sweeper & ₹0.30 Penalty Surcharge', () => {
    it('should cancel expired order, free partner, and penalize repeated unpaid cancellations', async () => {
      const userId = 'user_penalty_test_01';

      // Order 1: Accept then let payment expire
      const ord1Res = await request(app)
        .post('/api/v1/orders')
        .send({
          userId,
          items: [{ productId: prodNotebookId, quantity: 1 }],
          latitude: 22.5726,
          longitude: 88.3639,
          deliveryAddress: 'Howrah, Kolkata',
        });
      const order1Id = ord1Res.body.data.orderId;

      await request(app).post(`/api/v1/orders/${order1Id}/partner-accept`).send({ partnerId: partner1Id });

      // Artificially expire the 1-minute window
      const Order = getOrderModel();
      await Order.updateOne(
        { orderId: order1Id },
        { $set: { paymentSelectionExpiresAt: new Date(Date.now() - 5000) } }
      );

      // Run payment sweeper
      const swept = await orderService.sweepExpiredPaymentWindows();
      expect(swept).toBeGreaterThanOrEqual(1);

      // Verify order 1 status and partner freed
      const updatedOrder1 = await Order.findOne({ orderId: order1Id });
      expect(updatedOrder1?.status).toBe('CANCELLED_PAYMENT_TIMEOUT');

      const Partner = getPartnerModel();
      const freedPartner = await Partner.findOne({ partnerId: partner1Id });
      expect(freedPartner?.activeOrderId).toBeNull();
      expect(freedPartner?.isOnline).toBe(true);

      // Verify 1st cancellation used mercy
      const UserOrderProfile = getUserOrderProfileModel();
      let profile = await UserOrderProfile.findOne({ userId });
      expect(profile?.unpaidCancellationsCount).toBe(1);
      expect(profile?.penaltySurchargeApplies).toBeFalsy();

      // Order 2: Repeat timeout to trigger penalty surcharge (>= 2 cancellations)
      const ord2Res = await request(app)
        .post('/api/v1/orders')
        .send({
          userId,
          items: [{ productId: prodNotebookId, quantity: 1 }],
          latitude: 22.5726,
          longitude: 88.3639,
          deliveryAddress: 'Howrah, Kolkata',
        });
      const order2Id = ord2Res.body.data.orderId;

      await request(app).post(`/api/v1/orders/${order2Id}/partner-accept`).send({ partnerId: partner1Id });
      await Order.updateOne(
        { orderId: order2Id },
        { $set: { paymentSelectionExpiresAt: new Date(Date.now() - 5000) } }
      );

      await orderService.sweepExpiredPaymentWindows();

      profile = await UserOrderProfile.findOne({ userId });
      expect(profile?.unpaidCancellationsCount).toBe(2);
      expect(profile?.penaltySurchargeApplies).toBe(true);

      // Order 3: Should now have ₹0.30 penalty surcharge automatically applied!
      const ord3Res = await request(app)
        .post('/api/v1/orders')
        .send({
          userId,
          items: [{ productId: prodNotebookId, quantity: 1 }], // ₹60 + ₹15 delivery + ₹0.30 penalty
          latitude: 22.5726,
          longitude: 88.3639,
          deliveryAddress: 'Howrah, Kolkata',
        });

      expect(ord3Res.status).toBe(201);
      expect(ord3Res.body.data.cancellationPenaltySurcharge).toBe(0.3);
      expect(ord3Res.body.data.totalAmount).toBe(75.3);
    });
  });

  describe('Bug Test 5: Partner 5:1 Online-to-Offline Fairness Ratio', () => {
    it('should restrict offline cash delivery if partner ratio exceeds 5:1 limit', async () => {
      const Partner = getPartnerModel();
      // Set partner to 0 online orders and 1 offline order (ratio exceeded)
      await Partner.updateOne(
        { partnerId: partner1Id },
        { $set: { onlineOrdersCompleted: 0, offlineOrdersCompleted: 1 } }
      );

      const profileRes = await request(app).get(`/api/v1/partners/${partner1Id}/profile`);
      expect(profileRes.status).toBe(200);
      expect(profileRes.body.data.paymentModeRatioStatus.isEligible).toBe(false);
      expect(profileRes.body.data.paymentModeRatioStatus.reason).toContain('5:1');
    });
  });

  describe('Bug Test 6: Cash OTP & Final Delivery OTP Double Handshake', () => {
    it('should enforce strict 6-digit OTP verification at cash collection and final delivery', async () => {
      // 1. Create order
      const orderRes = await request(app)
        .post('/api/v1/orders')
        .send({
          userId: 'user_otp_flow',
          userEmail: 'user_otp@example.com',
          items: [{ productId: prodNotebookId, quantity: 1 }],
          latitude: 22.5726,
          longitude: 88.3639,
          deliveryAddress: 'Sealdah, Kolkata',
        });
      const orderId = orderRes.body.data.orderId;

      // 2. Partner accepts
      await request(app).post(`/api/v1/orders/${orderId}/partner-accept`).send({ partnerId: partner1Id });

      // 3. User selects OFFLINE cash payment
      await request(app).post(`/api/v1/orders/${orderId}/payment-mode`).send({
        userId: 'user_otp_flow',
        paymentMode: 'OFFLINE',
      });

      // 4. Partner marks reached for cash collection
      await request(app).post(`/api/v1/orders/${orderId}/partner-reached`).send({
        partnerId: partner1Id,
        stage: 'cash',
      });

      // Fetch generated OTP from DB
      const Order = getOrderModel();
      let order = await Order.findOne({ orderId });
      const cashOtp = order?.cashCollectionOtp!;
      expect(cashOtp).toBeDefined();
      expect(cashOtp).toHaveLength(6);

      // Invalid OTP fails
      const invalidOtpRes = await request(app)
        .post(`/api/v1/orders/${orderId}/verify-cash-otp`)
        .send({ partnerId: partner1Id, otp: '000000' });
      expect(invalidOtpRes.status).toBe(400);

      // Valid OTP verifies cash collection
      const validCashRes = await request(app)
        .post(`/api/v1/orders/${orderId}/verify-cash-otp`)
        .send({ partnerId: partner1Id, otp: cashOtp });
      expect(validCashRes.status).toBe(200);
      expect(validCashRes.body.data.isCashCollected).toBe(true);

      // 5. Partner marks reached for final delivery
      await request(app).post(`/api/v1/orders/${orderId}/partner-reached`).send({
        partnerId: partner1Id,
        stage: 'delivery',
      });

      order = await Order.findOne({ orderId });
      const deliveryOtp = order?.deliveryOtp!;
      expect(deliveryOtp).toBeDefined();

      // Verify delivery OTP
      const validDelRes = await request(app)
        .post(`/api/v1/orders/${orderId}/verify-delivery-otp`)
        .send({ partnerId: partner1Id, otp: deliveryOtp });
      expect(validDelRes.status).toBe(200);
      expect(validDelRes.body.data.status).toBe('DELIVERED');

      // Verify partner virtual wallet was credited with delivery fee
      const PartnerWallet = getPartnerWalletModel();
      const wallet = await PartnerWallet.findOne({ partnerId: partner1Id });
      expect(wallet?.virtualBalance).toBeGreaterThan(0);
    });
  });

  describe('Bug Test 7: Travel Timer Mechanics & One-Time Mercy Extension', () => {
    it('should grant 1-time mercy extension and penalize second extension request', async () => {
      const orderRes = await request(app)
        .post('/api/v1/orders')
        .send({
          userId: 'user_mercy_test',
          items: [{ productId: prodNotebookId, quantity: 1 }],
          latitude: 22.5726,
          longitude: 88.3639,
          deliveryAddress: 'New Town, Kolkata',
        });
      const orderId = orderRes.body.data.orderId;

      await request(app).post(`/api/v1/orders/${orderId}/partner-accept`).send({ partnerId: partner1Id });
      await request(app).post(`/api/v1/orders/${orderId}/payment-mode`).send({
        userId: 'user_mercy_test',
        paymentMode: 'OFFLINE',
      });

      // 1st mercy extension request: GRANTED
      const mercy1 = await request(app)
        .post(`/api/v1/orders/${orderId}/request-mercy-extension`)
        .send({
          partnerId: partner1Id,
          stage: 'cash',
          remainingDistanceMeters: 400,
        });

      expect(mercy1.status).toBe(200);
      expect(mercy1.body.data.mercyGranted).toBe(true);

      // 2nd mercy extension request on same trip: DENIED & PENALIZED
      const mercy2 = await request(app)
        .post(`/api/v1/orders/${orderId}/request-mercy-extension`)
        .send({
          partnerId: partner1Id,
          stage: 'cash',
          remainingDistanceMeters: 300,
        });

      expect(mercy2.status).toBe(200);
      expect(mercy2.body.data.mercyGranted).toBe(false);

      const Partner = getPartnerModel();
      const partner = await Partner.findOne({ partnerId: partner1Id });
      expect(partner?.unexcusedDelaysCount).toBe(1);
      expect(partner?.reputationScore).toBeLessThan(100);
    });
  });

  describe('Bug Test 8: Partner Authentication & Password Security', () => {
    it('should register partner with secure hashed password and allow JWT login', async () => {
      const email = `partner.auth.${Date.now()}@example.com`;
      const password = 'StrongPassword123!';

      // Register
      const regRes = await request(app).post('/api/v1/partners/register').send({
        name: 'Suresh Raina',
        email,
        phone: '9988776655',
        password,
        transportMode: 'cycle',
      });

      expect(regRes.status).toBe(201);
      expect(regRes.body.data.token).toBeDefined();
      expect(regRes.body.data.partner.passwordHash).toBeUndefined(); // Never exposed

      // Login with correct password
      const loginRes = await request(app).post('/api/v1/partners/login').send({
        email,
        password,
      });

      expect(loginRes.status).toBe(200);
      expect(loginRes.body.data.token).toBeDefined();

      // Login with incorrect password
      const badLogin = await request(app).post('/api/v1/partners/login').send({
        email,
        password: 'WrongPassword',
      });

      expect(badLogin.status).toBe(401);
    });
  });

  describe('Bug Test 9: Customer Rating & Partner Behavioural Analysis', () => {
    it('should update partner rating, reputation, and compute behavioral tier', async () => {
      // 1. Deliver order
      const Order = getOrderModel();
      const order = await Order.create({
        orderId: `ORD-RATE-${Date.now()}`,
        userId: 'user_rating_test',
        userName: 'Test Customer',
        userEmail: 'customer@example.com',
        userPhone: '9876543210',
        deliveryLocation: { type: 'Point', coordinates: [88.3639, 22.5726] },
        latitude: 22.5726,
        longitude: 88.3639,
        deliveryAddress: 'Gariahat, Kolkata',
        items: [{ productId: prodNotebookId, title: 'Notebook', price: 60, quantity: 1, subtotal: 60 }],
        subtotal: 60,
        deliveryFee: 15,
        totalAmount: 75,
        status: 'DELIVERED',
        assignedPartnerId: partner1Id,
        isPaid: true,
      });

      // 2. Customer rates 5 stars
      const rateRes = await request(app)
        .post(`/api/v1/orders/${order.orderId}/rate`)
        .send({
          userId: 'user_rating_test',
          rating: 5,
          feedback: 'Super fast delivery and polite partner!',
        });

      expect(rateRes.status).toBe(200);
      expect(rateRes.body.data.rating).toBe(5);
      expect(rateRes.body.data.partnerRatingCount).toBe(1);

      // Rating twice is blocked with 409 Conflict
      const rateTwiceRes = await request(app)
        .post(`/api/v1/orders/${order.orderId}/rate`)
        .send({
          userId: 'user_rating_test',
          rating: 4,
        });
      expect(rateTwiceRes.status).toBe(409);

      // 3. Behavioral Analysis Engine
      const analysisRes = await request(app).get(`/api/v1/partners/${partner1Id}/behaviour-analysis`);
      expect(analysisRes.status).toBe(200);
      expect(analysisRes.body.data.scoring.behaviouralScore).toBeGreaterThan(0);
      expect(analysisRes.body.data.scoring.reliabilityTier).toBeDefined();
    });
  });

  describe('Bug Test 10: Real-Time Live Tracking & Product Management', () => {
    it('should provide dynamic live tracking and handle product catalog administration', async () => {
      // Live Tracking
      const Order = getOrderModel();
      const order = await Order.create({
        orderId: `ORD-TRACK-${Date.now()}`,
        userId: 'user_track_test',
        userName: 'Test Customer',
        userEmail: 'customer@example.com',
        userPhone: '9876543210',
        deliveryLocation: { type: 'Point', coordinates: [88.3639, 22.5726] },
        latitude: 22.5726,
        longitude: 88.3639,
        deliveryAddress: 'BBD Bagh, Kolkata',
        items: [{ productId: prodNotebookId, title: 'Notebook', price: 60, quantity: 1, subtotal: 60 }],
        subtotal: 60,
        deliveryFee: 15,
        totalAmount: 75,
        status: 'DELIVERY_IN_PROGRESS',
        assignedPartnerId: partner1Id,
        partnerTransportMode: 'cycle',
      });

      const trackRes = await request(app).get(`/api/v1/orders/${order.orderId}/live-track`);
      expect(trackRes.status).toBe(200);
      expect(trackRes.body.data.remainingDistanceMeters).toBeGreaterThan(0);
      expect(trackRes.body.data.estimatedRemainingSeconds).toBeGreaterThan(0);
      expect(trackRes.body.data.partner.partnerId).toBe(partner1Id);
      expect(trackRes.body.data.travelStage).toBe('FINAL_DELIVERY');

      // Product Categories
      const catRes = await request(app).get('/api/v1/products/categories/all');
      expect(catRes.status).toBe(200);
      expect(catRes.body.data).toContain('stationery');

      // Admin Soft Delete Product
      const delRes = await request(app).delete(`/api/v1/products/${prodNotebookId}`);
      expect(delRes.status).toBe(200);
      expect(delRes.body.data.isDeleted).toBe(true);

      // Soft deleted product should not be returned in active list
      const listRes = await request(app).get('/api/v1/products');
      const items = listRes.body.data;
      const foundDeleted = items.some((p: any) => p._id === prodNotebookId);
      expect(foundDeleted).toBe(false);
    });
  });

  describe('Bug Test 11: Missing Features Verification (Pickup, Cancellation, Active Orders, Rush Status, Wallet Withdrawal & Transactions)', () => {
    it('should evaluate 2.5km delivery rush status and active order queries for customer and partner', async () => {
      // 1. Rush Status
      const rushRes = await request(app)
        .get('/api/v1/orders/rush-status')
        .query({ latitude: 22.5726, longitude: 88.3639 });

      expect(rushRes.status).toBe(200);
      expect(rushRes.body.success).toBe(true);
      expect(rushRes.body.data.availablePartnersInZone).toBeGreaterThanOrEqual(1);
      expect(typeof rushRes.body.data.isRush).toBe('boolean');
      expect(rushRes.body.data.rushRatio).toBeDefined();

      // 2. Active order when none exists
      const emptyActiveRes = await request(app).get('/api/v1/orders/user/user_new_feature_test/active');
      expect(emptyActiveRes.status).toBe(200);
      expect(emptyActiveRes.body.data).toBeNull();

      // 3. Create active order for user
      const Order = getOrderModel();
      const testOrderId = `ORD-NEWFEAT-${Date.now()}`;
      const activeOrder = await Order.create({
        orderId: testOrderId,
        userId: 'user_new_feature_test',
        userName: 'Feature Customer',
        userEmail: 'feat@example.com',
        userPhone: '9876543299',
        deliveryLocation: { type: 'Point', coordinates: [88.3639, 22.5726] },
        latitude: 22.5726,
        longitude: 88.3639,
        deliveryAddress: 'Park Street, Kolkata',
        items: [{ productId: prodPenId, title: 'Gel Pen', price: 30, quantity: 1, subtotal: 30 }],
        subtotal: 30,
        deliveryFee: 15,
        totalAmount: 45,
        status: 'PAID',
        assignedPartnerId: partner1Id,
        partnerTransportMode: 'cycle',
      });

      // 4. Verify Customer Active Order
      const userActiveRes = await request(app).get('/api/v1/orders/user/user_new_feature_test/active');
      expect(userActiveRes.status).toBe(200);
      expect(userActiveRes.body.data.orderId).toBe(testOrderId);

      // 5. Verify Partner Active Order
      const partnerActiveRes = await request(app).get(`/api/v1/partners/${partner1Id}/active-order`);
      expect(partnerActiveRes.status).toBe(200);
      expect(partnerActiveRes.body.data.orderId).toBe(testOrderId);

      // 6. Product Picked Up Lifecycle Transition
      const pickupRes = await request(app)
        .post(`/api/v1/orders/${testOrderId}/product-picked-up`)
        .send({ partnerId: partner1Id });

      expect(pickupRes.status).toBe(200);
      expect(pickupRes.body.data.status).toBe('DELIVERY_IN_PROGRESS');
      expect(pickupRes.body.data.deliveryTripEtaSeconds).toBeGreaterThan(0);

      // Invalid pickup attempt when already picked up
      const invalidPickupRes = await request(app)
        .post(`/api/v1/orders/${testOrderId}/product-picked-up`)
        .send({ partnerId: partner1Id });
      expect(invalidPickupRes.status).toBe(400);

      // 7. Customer Order Cancellation
      const cancelRes = await request(app)
        .post(`/api/v1/orders/${testOrderId}/cancel`)
        .send({ userId: 'user_new_feature_test', reason: 'Customer changed plans' });

      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body.data.status).toBe('CANCELLED_BY_USER');

      // Cannot cancel already cancelled order
      const cancelTwiceRes = await request(app)
        .post(`/api/v1/orders/${testOrderId}/cancel`)
        .send({ userId: 'user_new_feature_test' });
      expect(cancelTwiceRes.status).toBe(409);

      // Active order now returns null
      const postCancelActiveRes = await request(app).get('/api/v1/orders/user/user_new_feature_test/active');
      expect(postCancelActiveRes.status).toBe(200);
      expect(postCancelActiveRes.body.data).toBeNull();
    });

    it('should process partner wallet withdrawals and maintain paginated transaction ledgers', async () => {
      const PartnerWallet = getPartnerWalletModel();
      const testPartnerId = `PTR-WDL-${Date.now()}`;

      // Initialize partner wallet with starting virtual balance
      await PartnerWallet.create({
        partnerId: testPartnerId,
        virtualBalance: 500.0,
        totalEarned: 500.0,
        transactions: [
          {
            transactionId: `TXN-INIT-${Date.now()}`,
            amount: 500.0,
            type: 'credit',
            category: 'delivery_fee',
            description: 'Accumulated delivery earnings',
            createdAt: new Date(),
          },
        ],
      });

      // 1. Successful withdrawal of ₹175
      const withdrawRes = await request(app)
        .post(`/api/v1/partners/${testPartnerId}/wallet/withdraw`)
        .send({ amount: 175 });

      expect(withdrawRes.status).toBe(200);
      expect(withdrawRes.body.data.withdrawnAmount).toBe(175);
      expect(withdrawRes.body.data.remainingBalance).toBe(325);
      expect(withdrawRes.body.data.transaction.category).toBe('withdrawal');

      // 2. Overdraft rejection
      const overdraftRes = await request(app)
        .post(`/api/v1/partners/${testPartnerId}/wallet/withdraw`)
        .send({ amount: 1000 });
      expect(overdraftRes.status).toBe(400);
      expect(overdraftRes.body.error.message).toMatch(/Insufficient virtual balance/);

      // 3. Invalid / non-positive amount rejection
      const negativeRes = await request(app)
        .post(`/api/v1/partners/${testPartnerId}/wallet/withdraw`)
        .send({ amount: -50 });
      expect(negativeRes.status).toBe(400);

      // 4. View transaction history
      const historyRes = await request(app)
        .get(`/api/v1/partners/${testPartnerId}/wallet/transactions`)
        .query({ page: 1, limit: 10 });

      expect(historyRes.status).toBe(200);
      expect(historyRes.body.data.length).toBe(2); // 1 credit + 1 withdrawal debit
      expect(historyRes.body.data[0].category).toBe('withdrawal');
      expect(historyRes.body.total).toBe(2);
    });

    it('should process partner live GPS and telemetry ping and maintain live status', async () => {
      const pingRes = await request(app)
        .post(`/api/v1/partners/${partner1Id}/ping`)
        .send({
          latitude: 22.5742,
          longitude: 88.3653,
          speed: 14.5,
          heading: 180,
          batteryLevel: 88,
          isCharging: false,
          networkStatus: '4g',
        });

      expect(pingRes.status).toBe(200);
      expect(pingRes.body.success).toBe(true);
      expect(pingRes.body.data.partnerId).toBe(partner1Id);
      expect(pingRes.body.data.status).toBe('online');
      expect(pingRes.body.data.isOnline).toBe(true);
      expect(pingRes.body.data.lastPingAt).toBeDefined();

      // Verify in Partner model
      const Partner = getPartnerModel();
      const updated = await Partner.findOne({ partnerId: partner1Id });
      expect(updated?.latitude).toBe(22.5742);
      expect(updated?.longitude).toBe(88.3653);
      expect(updated?.isOnline).toBe(true);
    });
  });
});
