import request from 'supertest';
import { createApp } from '../src/app';
import { getProductModel } from '../src/models/Product';
import { getPartnerModel } from '../src/models/Partner';
import { getPartnerWalletModel } from '../src/models/PartnerWallet';
import { getUserOrderProfileModel } from '../src/models/UserOrderProfile';
import { getOrderModel } from '../src/models/Order';

const app = createApp();

describe('User Order System, Pricing, 2.5km Ring Dispatch & Partner Handshake', () => {
  let prodNotebookId: string;
  let prodPenId: string;
  let partner1Id = 'PTR-TEST-01';
  let partner2Id = 'PTR-TEST-02';

  beforeEach(async () => {
    const Product = getProductModel();
    const Partner = getPartnerModel();

    // 1. Seed Products
    const notebook = await Product.create({
      title: 'Classmate Spiral Notebook',
      slug: 'classmate-spiral-notebook',
      description: '200 pages ruled spiral notebook',
      category: 'stationery',
      sku: 'SKU-NB-200',
      price: 60.0,
      stock: 50,
      isActive: true,
      isDeleted: false,
    });
    prodNotebookId = notebook._id.toString();

    const pen = await Product.create({
      title: 'Reynolds Gel Pen',
      slug: 'reynolds-gel-pen',
      description: 'Blue ink gel pen',
      category: 'stationery',
      sku: 'SKU-PEN-01',
      price: 10.0,
      stock: 100,
      isActive: true,
      isDeleted: false,
    });
    prodPenId = pen._id.toString();

    // 2. Seed 2 Online Partners (within 2.5 km of 22.5726, 88.3639)
    await Partner.create([
      {
        partnerId: partner1Id,
        name: 'Amit Kumar',
        email: 'amit@example.com',
        phone: '9876543211',
        isOnline: true,
        transportMode: 'cycle',
        latitude: 22.5740,
        longitude: 88.3650, // ~200m away (Box 1)
        currentLocation: { type: 'Point', coordinates: [88.3650, 22.5740] },
      },
      {
        partnerId: partner2Id,
        name: 'Bikash Roy',
        email: 'bikash@example.com',
        phone: '9876543212',
        isOnline: true,
        transportMode: 'walk',
        latitude: 22.5800,
        longitude: 88.3700, // ~1km away (Box 2/3)
        currentLocation: { type: 'Point', coordinates: [88.3700, 22.5800] },
      },
    ]);
  });

  describe('Order Creation & Minimum Value Validation', () => {
    it('should reject orders with total below ₹30.00 with 400 Bad Request', async () => {
      // 1 pen = ₹10 (< ₹30)
      const res = await request(app)
        .post('/api/v1/orders')
        .send({
          userId: 'usr_order_01',
          items: [{ productId: prodPenId, quantity: 1 }],
          latitude: 22.5726,
          longitude: 88.3639,
          deliveryAddress: 'Hostel 4, Room 202, Campus',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('Minimum order value is ₹30.00');
    });

    it('should reject order with 503 Partner Crisis when fewer than 2 partners are online', async () => {
      // Take partner2 offline so only 1 partner is online
      const Partner = getPartnerModel();
      await Partner.updateOne({ partnerId: partner2Id }, { $set: { isOnline: false } });

      const res = await request(app)
        .post('/api/v1/orders')
        .send({
          userId: 'usr_order_crisis',
          items: [{ productId: prodNotebookId, quantity: 1 }], // ₹60 >= ₹30
          latitude: 22.5726,
          longitude: 88.3639,
          deliveryAddress: 'Main Library, Gate 2',
        });

      expect(res.status).toBe(503);
      expect(res.body.error.message).toContain('partner crisis');
    });

    it('should successfully create order and ring partners when minimum order is met and >= 2 partners online', async () => {
      const res = await request(app)
        .post('/api/v1/orders')
        .send({
          userId: 'usr_order_success',
          userName: 'Debjit Das',
          userEmail: 'debjit@example.com',
          userPhone: '9876543210',
          items: [{ productId: prodNotebookId, quantity: 1 }], // ₹60
          latitude: 22.5726,
          longitude: 88.3639,
          deliveryAddress: 'Academic Complex Block B',
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.subtotal).toBe(60.0);
      expect(res.body.data.totalAmount).toBeGreaterThan(60.0);
      expect(res.body.data.status).toBe('SEARCHING_PARTNER');
      expect(res.body.data.notifiedPartnerIds.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Atomic First-Pick Order Acceptance', () => {
    let orderId: string;

    beforeEach(async () => {
      const res = await request(app)
        .post('/api/v1/orders')
        .send({
          userId: 'usr_order_race',
          items: [{ productId: prodNotebookId, quantity: 1 }],
          latitude: 22.5726,
          longitude: 88.3639,
          deliveryAddress: 'Hostel 7, Floor 3',
        });
      orderId = res.body.data.orderId;
    });

    it('should assign order to the 1st partner who picks it up and start 1-min countdown', async () => {
      const res = await request(app)
        .post(`/api/v1/orders/${orderId}/partner-accept`)
        .send({ partnerId: partner1Id });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.assignedPartnerId).toBe(partner1Id);
      expect(res.body.data.status).toBe('PAYMENT_PENDING');
      expect(res.body.data.paymentSelectionExpiresAt).toBeDefined();
    });

    it('should reject a second partner attempting to pick up the same order with 409 Conflict', async () => {
      // Partner 1 accepts first
      await request(app)
        .post(`/api/v1/orders/${orderId}/partner-accept`)
        .send({ partnerId: partner1Id });

      // Partner 2 attempts to accept
      const res = await request(app)
        .post(`/api/v1/orders/${orderId}/partner-accept`)
        .send({ partnerId: partner2Id });

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error.message).toContain('already been picked up');
    });
  });

  describe('Payment Mode Selection & 1-Minute Expiration Rules', () => {
    let orderId: string;

    beforeEach(async () => {
      const res = await request(app)
        .post('/api/v1/orders')
        .send({
          userId: 'usr_payment_test',
          items: [{ productId: prodNotebookId, quantity: 1 }],
          latitude: 22.5726,
          longitude: 88.3639,
          deliveryAddress: 'Hostel 1, Room 10',
        });
      orderId = res.body.data.orderId;

      await request(app)
        .post(`/api/v1/orders/${orderId}/partner-accept`)
        .send({ partnerId: partner1Id });
    });

    it('should allow user to select ONLINE payment mode and prepare gateway', async () => {
      const res = await request(app)
        .post(`/api/v1/orders/${orderId}/select-payment`)
        .send({ userId: 'usr_payment_test', paymentMode: 'ONLINE' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.paymentMode).toBe('ONLINE');
      expect(res.body.data.razorpayOrderId).toBeDefined();
    });

    it('should allow user to select OFFLINE cash mode and compute travel ETA', async () => {
      const res = await request(app)
        .post(`/api/v1/orders/${orderId}/select-payment`)
        .send({ userId: 'usr_payment_test', paymentMode: 'OFFLINE' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.paymentMode).toBe('OFFLINE');
      expect(res.body.data.status).toBe('CASH_COLLECTION_IN_PROGRESS');
      expect(res.body.data.cashTripEtaSeconds).toBeGreaterThan(0);
    });

    it('should reject payment selection if 1-minute window expired and apply cancellation penalty on 2nd offense', async () => {
      const Order = getOrderModel();
      // Set expired timestamp
      await Order.updateOne(
        { orderId },
        { $set: { paymentSelectionExpiresAt: new Date(Date.now() - 5000) } }
      );

      const res = await request(app)
        .post(`/api/v1/orders/${orderId}/select-payment`)
        .send({ userId: 'usr_payment_test', paymentMode: 'ONLINE' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('window expired');

      // Verify user order profile tracked the cancellation
      const UserOrderProfile = getUserOrderProfileModel();
      const profile = await UserOrderProfile.findOne({ userId: 'usr_payment_test' });
      expect(profile?.unpaidCancellationsCount).toBe(1);
      expect(profile?.hasUsedCancellationMercy).toBe(true);
      expect(profile?.penaltySurchargeApplies).toBe(false); // 1st is mercy
    });
  });

  describe('30 Paisa Penalty Surcharge on 2nd Cancellation', () => {
    it('should apply +₹0.30 surcharge on new orders when user has >= 2 unpaid cancellations', async () => {
      const UserOrderProfile = getUserOrderProfileModel();
      // Pre-seed user with 2 cancellations
      await UserOrderProfile.create({
        userId: 'usr_habitual_canceller',
        unpaidCancellationsCount: 2,
        hasUsedCancellationMercy: true,
        penaltySurchargeApplies: true,
      });

      const res = await request(app)
        .post('/api/v1/orders')
        .send({
          userId: 'usr_habitual_canceller',
          items: [{ productId: prodNotebookId, quantity: 1 }], // ₹60
          latitude: 22.5726,
          longitude: 88.3639,
          deliveryAddress: 'Hostel 3, Room 4',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.cancellationPenaltySurcharge).toBe(0.3); // 30 paisa
      expect(res.body.data.totalAmount).toBe(60.0 + 15.0 + 0.3); // Subtotal + Delivery + 30 paisa
    });
  });

  describe('Offline Cash Handshake & Final Delivery OTP Verification', () => {
    let orderId: string;

    beforeEach(async () => {
      const res = await request(app)
        .post('/api/v1/orders')
        .send({
          userId: 'usr_otp_test',
          userEmail: 'student@example.com',
          items: [{ productId: prodNotebookId, quantity: 1 }],
          latitude: 22.5726,
          longitude: 88.3639,
          deliveryAddress: 'Hostel 2, Room 12',
        });
      orderId = res.body.data.orderId;

      await request(app)
        .post(`/api/v1/orders/${orderId}/partner-accept`)
        .send({ partnerId: partner1Id });

      await request(app)
        .post(`/api/v1/orders/${orderId}/select-payment`)
        .send({ userId: 'usr_otp_test', paymentMode: 'OFFLINE' });
    });

    it('should execute full offline flow: reached -> cash OTP -> delivery reached -> delivery OTP', async () => {
      // 1. Partner reaches user for cash collection
      const reachedCashRes = await request(app)
        .post(`/api/v1/orders/${orderId}/partner-reached`)
        .send({ partnerId: partner1Id, stage: 'cash' });

      expect(reachedCashRes.status).toBe(200);

      const Order = getOrderModel();
      let orderDoc = await Order.findOne({ orderId });
      expect(orderDoc?.cashCollectionOtp).toBeDefined();
      const cashOtp = orderDoc!.cashCollectionOtp!;

      // 2. Partner verifies cash OTP
      const verifyCashRes = await request(app)
        .post(`/api/v1/orders/${orderId}/verify-cash-otp`)
        .send({ partnerId: partner1Id, otp: cashOtp });

      expect(verifyCashRes.status).toBe(200);
      expect(verifyCashRes.body.data.isCashCollected).toBe(true);
      expect(verifyCashRes.body.data.status).toBe('CASH_COLLECTED');

      // 3. Partner fetches product and reaches user for final delivery
      const reachedDelivRes = await request(app)
        .post(`/api/v1/orders/${orderId}/partner-reached`)
        .send({ partnerId: partner1Id, stage: 'delivery' });

      expect(reachedDelivRes.status).toBe(200);

      orderDoc = await Order.findOne({ orderId });
      expect(orderDoc?.deliveryOtp).toBeDefined();
      const deliveryOtp = orderDoc!.deliveryOtp!;

      // 4. Partner verifies delivery OTP
      const verifyDelivRes = await request(app)
        .post(`/api/v1/orders/${orderId}/verify-delivery-otp`)
        .send({ partnerId: partner1Id, otp: deliveryOtp });

      expect(verifyDelivRes.status).toBe(200);
      expect(verifyDelivRes.body.data.status).toBe('DELIVERED');

      // 5. Verify partner wallet virtual balance credited
      const PartnerWallet = getPartnerWalletModel();
      const wallet = await PartnerWallet.findOne({ partnerId: partner1Id });
      expect(wallet?.virtualBalance).toBeGreaterThan(0);
    });

    it('should grant one-time mercy extension if partner is delayed, but penalize reputation if delayed again', async () => {
      // First extension -> Mercy granted
      const ext1 = await request(app)
        .post(`/api/v1/orders/${orderId}/request-mercy-extension`)
        .send({ partnerId: partner1Id, stage: 'cash', remainingDistanceMeters: 400 });

      expect(ext1.status).toBe(200);
      expect(ext1.body.data.mercyGranted).toBe(true);

      // Second extension -> Rejected, reputation penalized
      const ext2 = await request(app)
        .post(`/api/v1/orders/${orderId}/request-mercy-extension`)
        .send({ partnerId: partner1Id, stage: 'cash', remainingDistanceMeters: 300 });

      expect(ext2.status).toBe(200);
      expect(ext2.body.data.mercyGranted).toBe(false);

      const Partner = getPartnerModel();
      const partner = await Partner.findOne({ partnerId: partner1Id });
      expect(partner?.reputationScore).toBe(95); // 100 - 5
    });
  });
});
