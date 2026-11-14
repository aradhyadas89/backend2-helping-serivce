import request from 'supertest';
import { createApp } from '../src/app';
import { getProductModel } from '../src/models/Product';
import { getPartnerModel } from '../src/models/Partner';
import { getPartnerWalletModel } from '../src/models/PartnerWallet';
import { getOrderModel } from '../src/models/Order';
import { razorpayService } from '../src/services/razorpay.service';
import { env } from '../src/config/env';

const app = createApp();

describe('Razorpay Payment Gateway Integration', () => {
  let prodId: string;
  const partnerId = 'PTR-RZP-01';
  const partner2Id = 'PTR-RZP-02';
  const userId = 'usr_razorpay_customer';

  beforeEach(async () => {
    const Product = getProductModel();
    const Partner = getPartnerModel();

    // 1. Seed Product
    const prod = await Product.create({
      title: 'Engineering Mechanics Textbook',
      slug: 'engg-mechanics-tb',
      description: 'Standard textbook for first year',
      category: 'stationery',
      sku: 'SKU-EM-01',
      price: 150.0,
      stock: 25,
      isActive: true,
      isDeleted: false,
    });
    prodId = prod._id.toString();

    // 2. Seed 2 Online Partners within zone
    await Partner.create([
      {
        partnerId,
        name: 'Rahul Sharma',
        email: 'rahul@example.com',
        phone: '9876543220',
        isOnline: true,
        transportMode: 'cycle',
        latitude: 22.5730,
        longitude: 88.3640,
        currentLocation: { type: 'Point', coordinates: [88.3640, 22.5730] },
      },
      {
        partnerId: partner2Id,
        name: 'Suresh Das',
        email: 'suresh@example.com',
        phone: '9876543221',
        isOnline: true,
        transportMode: 'cycle',
        latitude: 22.5735,
        longitude: 88.3645,
        currentLocation: { type: 'Point', coordinates: [88.3645, 22.5735] },
      },
    ]);
  });

  async function createAcceptedOrder(): Promise<string> {
    const createRes = await request(app)
      .post('/api/v1/orders')
      .send({
        userId,
        userName: 'Rahul Verma',
        userEmail: 'rahul.verma@example.com',
        userPhone: '9876543200',
        items: [{ productId: prodId, quantity: 1 }],
        latitude: 22.5726,
        longitude: 88.3639,
        deliveryAddress: 'Hostel 7, Room 301',
      });

    const orderId = createRes.body.data.orderId;

    await request(app)
      .post(`/api/v1/orders/${orderId}/partner-accept`)
      .send({ partnerId });

    return orderId;
  }

  describe('1. Order Creation & Razorpay Gateway Initialization', () => {
    it('should select ONLINE mode, generate Razorpay order ID, and return client credentials', async () => {
      const orderId = await createAcceptedOrder();

      const res = await request(app)
        .post(`/api/v1/orders/${orderId}/select-payment`)
        .send({ userId, paymentMode: 'ONLINE' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.paymentMode).toBe('ONLINE');
      expect(res.body.data.razorpayOrderId).toBeDefined();
      expect(res.body.data.razorpayKeyId).toBe(env.RAZORPAY_KEY_ID);
      expect(res.body.data.currency).toBe('INR');
      expect(res.body.data.amountInPaise).toBe(Math.round(res.body.data.totalAmount * 100));

      const Order = getOrderModel();
      const saved = await Order.findOne({ orderId });
      expect(saved?.razorpayOrderId).toBe(res.body.data.razorpayOrderId);
      expect(saved?.status).toBe('PAYMENT_PENDING');
      expect(saved?.isPaid).toBe(false);
    });
  });

  describe('2. Payment Verification & Partner Virtual Wallet Credit', () => {
    it('should successfully verify payment with valid HMAC-SHA256 signature and credit partner wallet', async () => {
      const orderId = await createAcceptedOrder();

      const selectRes = await request(app)
        .post(`/api/v1/orders/${orderId}/select-payment`)
        .send({ userId, paymentMode: 'ONLINE' });

      const razorpayOrderId = selectRes.body.data.razorpayOrderId;
      const razorpayPaymentId = `pay_rzp_${Date.now()}`;
      const razorpaySignature = razorpayService.generateSignature(razorpayOrderId, razorpayPaymentId);

      const verifyRes = await request(app)
        .post(`/api/v1/orders/${orderId}/verify-payment`)
        .send({
          razorpayOrderId,
          razorpayPaymentId,
          razorpaySignature,
        });

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.success).toBe(true);
      expect(verifyRes.body.data.status).toBe('PAID');
      expect(verifyRes.body.data.isPaid).toBe(true);
      expect(verifyRes.body.data.razorpayPaymentId).toBe(razorpayPaymentId);
      expect(verifyRes.body.data.paidAt).toBeDefined();

      // Check partner wallet was credited with deliveryFee
      const PartnerWallet = getPartnerWalletModel();
      const wallet = await PartnerWallet.findOne({ partnerId });
      expect(wallet).toBeDefined();
      expect(wallet?.virtualBalance).toBe(15.0); // Delivery fee is ₹15.00
    });

    it('should reject payment verification if cryptographic signature is invalid or tampered', async () => {
      const orderId = await createAcceptedOrder();

      const selectRes = await request(app)
        .post(`/api/v1/orders/${orderId}/select-payment`)
        .send({ userId, paymentMode: 'ONLINE' });

      const razorpayOrderId = selectRes.body.data.razorpayOrderId;
      const razorpayPaymentId = `pay_rzp_${Date.now()}`;
      const tamperedSignature = 'deadbeef0123456789abcdef0123456789abcdef0123456789abcdef01234567';

      const verifyRes = await request(app)
        .post(`/api/v1/orders/${orderId}/verify-payment`)
        .send({
          razorpayOrderId,
          razorpayPaymentId,
          razorpaySignature: tamperedSignature,
        });

      expect(verifyRes.status).toBe(400);
      expect(verifyRes.body.error.message).toContain('Invalid Razorpay payment signature');
    });

    it('should reject payment verification if razorpayOrderId does not match order record', async () => {
      const orderId = await createAcceptedOrder();

      await request(app)
        .post(`/api/v1/orders/${orderId}/select-payment`)
        .send({ userId, paymentMode: 'ONLINE' });

      const mismatchedOrderId = 'order_fake_mismatch_123';
      const razorpayPaymentId = 'pay_fake_123';
      const signature = razorpayService.generateSignature(mismatchedOrderId, razorpayPaymentId);

      const verifyRes = await request(app)
        .post(`/api/v1/orders/${orderId}/verify-payment`)
        .send({
          razorpayOrderId: mismatchedOrderId,
          razorpayPaymentId,
          razorpaySignature: signature,
        });

      expect(verifyRes.status).toBe(400);
      expect(verifyRes.body.error.message).toContain('Razorpay order ID mismatch');
    });
  });

  describe('3. Payment Status & Gateway Telemetry', () => {
    it('should retrieve payment and gateway status for an order', async () => {
      const orderId = await createAcceptedOrder();

      const selectRes = await request(app)
        .post(`/api/v1/orders/${orderId}/select-payment`)
        .send({ userId, paymentMode: 'ONLINE' });

      const razorpayOrderId = selectRes.body.data.razorpayOrderId;
      const razorpayPaymentId = `pay_test_${Date.now()}`;
      const razorpaySignature = razorpayService.generateSignature(razorpayOrderId, razorpayPaymentId);

      await request(app)
        .post(`/api/v1/orders/${orderId}/verify-payment`)
        .send({ razorpayOrderId, razorpayPaymentId, razorpaySignature });

      const statusRes = await request(app).get(`/api/v1/orders/${orderId}/payment-status`);

      expect(statusRes.status).toBe(200);
      expect(statusRes.body.data.orderId).toBe(orderId);
      expect(statusRes.body.data.isPaid).toBe(true);
      expect(statusRes.body.data.paymentMode).toBe('ONLINE');
      expect(statusRes.body.data.razorpayPaymentId).toBe(razorpayPaymentId);
      expect(statusRes.body.data.gatewayDetails).toBeDefined();
    });
  });

  describe('4. Automatic Razorpay Refund on Order Cancellation', () => {
    it('should automatically trigger refund when customer cancels a paid online order', async () => {
      const orderId = await createAcceptedOrder();

      const selectRes = await request(app)
        .post(`/api/v1/orders/${orderId}/select-payment`)
        .send({ userId, paymentMode: 'ONLINE' });

      const razorpayOrderId = selectRes.body.data.razorpayOrderId;
      const razorpayPaymentId = `pay_paid_${Date.now()}`;
      const signature = razorpayService.generateSignature(razorpayOrderId, razorpayPaymentId);

      await request(app)
        .post(`/api/v1/orders/${orderId}/verify-payment`)
        .send({ razorpayOrderId, razorpayPaymentId, razorpaySignature: signature });

      // Customer cancels order
      const cancelRes = await request(app)
        .post(`/api/v1/orders/${orderId}/cancel`)
        .send({ userId, reason: 'Ordered wrong book by mistake' });

      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body.data.status).toBe('CANCELLED_BY_USER');
      expect(cancelRes.body.data.refundStatus).toBe('COMPLETED');
      expect(cancelRes.body.data.razorpayRefundId).toBeDefined();
      expect(cancelRes.body.data.refundAmount).toBe(cancelRes.body.data.totalAmount);
    });
  });

  describe('5. Asynchronous Razorpay Webhooks Reconciliation', () => {
    it('should process payment.captured webhook and auto-reconcile unpaid order', async () => {
      const orderId = await createAcceptedOrder();

      const selectRes = await request(app)
        .post(`/api/v1/orders/${orderId}/select-payment`)
        .send({ userId, paymentMode: 'ONLINE' });

      const razorpayOrderId = selectRes.body.data.razorpayOrderId;
      const webhookPaymentId = `pay_wh_${Date.now()}`;

      const webhookBody = {
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: webhookPaymentId,
              order_id: razorpayOrderId,
              amount: 16500,
              currency: 'INR',
              status: 'captured',
            },
          },
        },
      };

      const rawJson = JSON.stringify(webhookBody);
      const signature = razorpayService.generateSignature(razorpayOrderId, webhookPaymentId);

      const res = await request(app)
        .post('/api/v1/orders/webhook/razorpay')
        .set('x-razorpay-signature', signature)
        .send(webhookBody);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      // Verify order is now marked PAID in DB
      const Order = getOrderModel();
      const updatedOrder = await Order.findOne({ orderId });
      expect(updatedOrder?.isPaid).toBe(true);
      expect(updatedOrder?.status).toBe('PAID');
      expect(updatedOrder?.razorpayPaymentId).toBe(webhookPaymentId);
    });
  });
});
