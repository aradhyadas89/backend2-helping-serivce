import request from 'supertest';
import { createApp } from '../src/app';
import { getPartnerModel } from '../src/models/Partner';
import { getPartnerWalletModel } from '../src/models/PartnerWallet';
import { getOrderModel } from '../src/models/Order';
import { razorpayService } from '../src/services/razorpay.service';

const app = createApp();

describe('Assignment Writing Service & Tracker Algorithm', () => {
  const partner1Id = 'PTR-ASG-01';
  const partner2Id = 'PTR-ASG-02';
  const userId = 'usr_assignment_student';

  beforeEach(async () => {
    const Partner = getPartnerModel();

    // Seed 2 Online Partners in the 2.5km campus zone
    await Partner.create([
      {
        partnerId: partner1Id,
        name: 'Vikas Sharma',
        email: 'vikas@example.com',
        phone: '9876543301',
        isOnline: true,
        transportMode: 'cycle',
        latitude: 22.5740,
        longitude: 88.3645,
        currentLocation: { type: 'Point', coordinates: [88.3645, 22.5740] },
      },
      {
        partnerId: partner2Id,
        name: 'Pooja Verma',
        email: 'pooja@example.com',
        phone: '9876543302',
        isOnline: true,
        transportMode: 'cycle',
        latitude: 22.5730,
        longitude: 88.3635,
        currentLocation: { type: 'Point', coordinates: [88.3635, 22.5730] },
      },
    ]);
  });

  describe('1. Billing Algorithm: Written Charge (₹1) + Page Price (₹1)', () => {
    it('should calculate ₹1 writing charge + ₹1 page price = ₹2/page with word count estimation', async () => {
      // 550 words -> 3 pages (550 / 250 = 2.2 -> 3 pages)
      const textSample = Array(550).fill('assignment').join(' ');

      const res = await request(app)
        .post('/api/v1/orders/calculate-assignment-bill')
        .send({
          userId,
          assignmentText: textSample,
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.wordCount).toBe(550);
      expect(res.body.data.pageCount).toBe(3);
      expect(res.body.data.writingCharge).toBe(3.0); // 3 * ₹1
      expect(res.body.data.pagePrice).toBe(3.0); // 3 * ₹1
      expect(res.body.data.subtotal).toBe(6.0); // 3 * ₹2
      expect(res.body.data.deliveryFee).toBe(15.0);
      expect(res.body.data.totalAmount).toBe(21.0); // 6 + 15
      expect(res.body.data.handwrittenMinutes).toBeGreaterThanOrEqual(10);
    });

    it('should respect explicit page count when provided', async () => {
      const res = await request(app)
        .post('/api/v1/orders/calculate-assignment-bill')
        .send({
          userId,
          assignmentText: 'Short prompt with problem statement for 10 pages.',
          pageCount: 10,
        });

      expect(res.status).toBe(200);
      expect(res.body.data.pageCount).toBe(10);
      expect(res.body.data.writingCharge).toBe(10.0);
      expect(res.body.data.pagePrice).toBe(10.0);
      expect(res.body.data.subtotal).toBe(20.0);
      expect(res.body.data.totalAmount).toBe(35.0); // 20 + 15
    });
  });

  describe('2. Order Creation & Nearest Xerox Shop Tracker ETA Algorithm', () => {
    it('should create assignment writing order, locate nearest xerox shop, and calculate granular ETAs', async () => {
      const assignmentContent =
        'Please write the solution to Heat Transfer Problem 4.1 to 4.5. Include neat free body diagrams and highlight all final numerical answers with double underline.';
      const explanation =
        'Use standard A4 ruled sheets, blue ball pen for text, black gel pen for headings, leave 1-inch left margin.';

      const res = await request(app)
        .post('/api/v1/orders/assignment')
        .send({
          userId,
          userName: 'Arjun Das',
          userEmail: 'arjun.das@example.com',
          userPhone: '9876543399',
          latitude: 22.5726,
          longitude: 88.3639,
          deliveryAddress: 'Hostel 5, Room 214',
          assignmentText: assignmentContent,
          explanation,
          pageCount: 5,
        });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);

      const order = res.body.data;
      expect(order.orderType).toBe('ASSIGNMENT_WRITING');
      expect(order.status).toBe('SEARCHING_PARTNER');
      expect(order.assignmentDetails).toBeDefined();
      expect(order.assignmentDetails.pageCount).toBe(5);
      expect(order.assignmentDetails.totalPageCharge).toBe(10.0); // 5 * (₹1 + ₹1)
      expect(order.totalAmount).toBe(25.0); // 10 + 15

      // Check nearest Xerox shop calculation
      const shop = order.assignmentDetails.nearestXeroxShop;
      expect(shop).toBeDefined();
      expect(shop.name).toContain('Xerox');
      expect(shop.distanceMeters).toBeGreaterThan(0);

      // Check tracker ETAs
      expect(order.assignmentDetails.pageBuyingTimeMinutes).toBeGreaterThan(0);
      expect(order.assignmentDetails.handwrittenTimeMinutes).toBeGreaterThanOrEqual(10);
      expect(order.assignmentDetails.totalEtaMinutes).toBeGreaterThan(0);
      expect(order.assignmentDetails.estimatedDeliveryAt).toBeDefined();
    });
  });

  describe('3. Partner Atomic Acceptance & Online Payment Requirement', () => {
    let orderId: string;

    beforeEach(async () => {
      const res = await request(app)
        .post('/api/v1/orders/assignment')
        .send({
          userId,
          latitude: 22.5726,
          longitude: 88.3639,
          deliveryAddress: 'Hall of Residence 2',
          assignmentText: 'Mathematics 1 Assignment 3: Linear Algebra Eigenvalues',
          explanation: 'Step by step matrix calculations',
          pageCount: 6,
        });
      orderId = res.body.data.orderId;

      // Partner accepts
      await request(app)
        .post(`/api/v1/orders/${orderId}/partner-accept`)
        .send({ partnerId: partner1Id });
    });

    it('should REJECT offline cash payment for assignment writing (online-only enforcement)', async () => {
      const res = await request(app)
        .post(`/api/v1/orders/${orderId}/select-payment`)
        .send({ userId, paymentMode: 'OFFLINE' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('require ONLINE payment via Razorpay');
    });

    it('should accept ONLINE Razorpay payment and transition order to BUYING_PAGES', async () => {
      // 1. Select online mode
      const selectRes = await request(app)
        .post(`/api/v1/orders/${orderId}/select-payment`)
        .send({ userId, paymentMode: 'ONLINE' });

      expect(selectRes.status).toBe(200);
      const razorpayOrderId = selectRes.body.data.razorpayOrderId;
      expect(razorpayOrderId).toBeDefined();

      // 2. Verify payment
      const razorpayPaymentId = `pay_asg_${Date.now()}`;
      const signature = razorpayService.generateSignature(razorpayOrderId, razorpayPaymentId);

      const verifyRes = await request(app)
        .post(`/api/v1/orders/${orderId}/verify-payment`)
        .send({
          razorpayOrderId,
          razorpayPaymentId,
          razorpaySignature: signature,
        });

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.data.isPaid).toBe(true);
      expect(verifyRes.body.data.status).toBe('BUYING_PAGES');
      expect(verifyRes.body.data.assignmentDetails.currentStage).toBe('BUYING_PAGES');
    });
  });

  describe('4. Complete Writing Progress, Proximity Phone Ringing, & OTP Delivery Handshake', () => {
    let orderId: string;

    beforeEach(async () => {
      const res = await request(app)
        .post('/api/v1/orders/assignment')
        .send({
          userId,
          userEmail: 'student.delivery@example.com',
          latitude: 22.5726,
          longitude: 88.3639,
          deliveryAddress: 'Hostel 8, Room 102',
          assignmentText: 'Thermodynamics Carnot Cycle and Entropy Derivation',
          explanation: 'Clear neat handwriting with pencil drawn cycles',
          pageCount: 4,
        });
      orderId = res.body.data.orderId;

      await request(app)
        .post(`/api/v1/orders/${orderId}/partner-accept`)
        .send({ partnerId: partner1Id });

      const selectRes = await request(app)
        .post(`/api/v1/orders/${orderId}/select-payment`)
        .send({ userId, paymentMode: 'ONLINE' });

      const rzpOrderId = selectRes.body.data.razorpayOrderId;
      const rzpPayId = `pay_handshake_${Date.now()}`;
      const signature = razorpayService.generateSignature(rzpOrderId, rzpPayId);

      await request(app)
        .post(`/api/v1/orders/${orderId}/verify-payment`)
        .send({
          razorpayOrderId: rzpOrderId,
          razorpayPaymentId: rzpPayId,
          razorpaySignature: signature,
        });
    });

    it('should step through stages: buying pages -> writing assignment -> out for delivery -> proximity ring -> delivery OTP verified', async () => {
      // 1. Partner starts handwriting
      const writingStageRes = await request(app)
        .post(`/api/v1/orders/${orderId}/assignment/stage`)
        .send({ partnerId: partner1Id, stage: 'WRITING_ASSIGNMENT' });

      expect(writingStageRes.status).toBe(200);
      expect(writingStageRes.body.data.status).toBe('WRITING_ASSIGNMENT');

      // 2. Partner finishes and goes to user real-time location
      const deliveryStageRes = await request(app)
        .post(`/api/v1/orders/${orderId}/assignment/stage`)
        .send({ partnerId: partner1Id, stage: 'OUT_FOR_DELIVERY' });

      expect(deliveryStageRes.status).toBe(200);
      expect(deliveryStageRes.body.data.status).toBe('DELIVERY_IN_PROGRESS');

      // 3. Proximity Check & Phone Ringing Handshake (partner within 150m of user)
      const ringRes = await request(app)
        .post(`/api/v1/orders/${orderId}/proximity-ring`)
        .send({
          partnerId: partner1Id,
          partnerLatitude: 22.5728, // ~25m away
          partnerLongitude: 88.3640,
        });

      expect(ringRes.status).toBe(200);
      expect(ringRes.body.success).toBe(true);
      expect(ringRes.body.data.ringing).toBe(true);
      expect(ringRes.body.data.requiresOtp).toBe(true);

      // Verify delivery OTP was generated on order
      const Order = getOrderModel();
      const updatedOrder = await Order.findOne({ orderId });
      expect(updatedOrder?.status).toBe('PARTNER_REACHED_DELIVERY');
      expect(updatedOrder?.deliveryOtp).toBeDefined();
      const deliveryOtp = updatedOrder!.deliveryOtp!;

      // 4. Partner enters OTP and completes delivery
      const otpVerifyRes = await request(app)
        .post(`/api/v1/orders/${orderId}/verify-delivery-otp`)
        .send({ partnerId: partner1Id, otp: deliveryOtp });

      expect(otpVerifyRes.status).toBe(200);
      expect(otpVerifyRes.body.success).toBe(true);
      expect(otpVerifyRes.body.data.status).toBe('DELIVERED');

      // 5. Verify partner virtual balance credited
      const PartnerWallet = getPartnerWalletModel();
      const wallet = await PartnerWallet.findOne({ partnerId: partner1Id });
      expect(wallet).toBeDefined();
      expect(wallet?.virtualBalance).toBe(15.0); // Delivery fee earning
    });
  });
});
