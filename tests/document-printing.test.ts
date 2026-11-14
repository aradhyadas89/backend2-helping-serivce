import request from 'supertest';
import { createApp } from '../src/app';
import { getPartnerModel } from '../src/models/Partner';
import { getPartnerWalletModel } from '../src/models/PartnerWallet';
import { getOrderModel } from '../src/models/Order';
import { razorpayService } from '../src/services/razorpay.service';

const app = createApp();

describe('Document Printing Service & Google Drive Storage', () => {
  const partner1Id = 'PTR-PRN-01';
  const partner2Id = 'PTR-PRN-02';
  const userId = 'usr_printing_student';

  beforeEach(async () => {
    const Partner = getPartnerModel();

    // Seed 2 Online Partners within 2.5km radius
    await Partner.create([
      {
        partnerId: partner1Id,
        name: 'Sunil Sen',
        email: 'sunil@example.com',
        phone: '9876543401',
        isOnline: true,
        transportMode: 'cycle',
        latitude: 22.5738,
        longitude: 88.3642,
        currentLocation: { type: 'Point', coordinates: [88.3642, 22.5738] },
      },
      {
        partnerId: partner2Id,
        name: 'Ritu Nandi',
        email: 'ritu@example.com',
        phone: '9876543402',
        isOnline: true,
        transportMode: 'cycle',
        latitude: 22.5720,
        longitude: 88.3630,
        currentLocation: { type: 'Point', coordinates: [88.3630, 22.5720] },
      },
    ]);
  });

  describe('1. Billing Calculation Algorithm (BW vs Color)', () => {
    it('should calculate Black & White printing at ₹2.00 per page', async () => {
      const res = await request(app)
        .post('/api/v1/orders/calculate-printing-bill')
        .send({
          userId,
          pageCount: 10,
          copies: 2,
          colorMode: 'BW',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.pageCount).toBe(10);
      expect(res.body.data.copies).toBe(2);
      expect(res.body.data.ratePerPage).toBe(2.0);
      expect(res.body.data.subtotal).toBe(40.0); // 10 * 2 * 2 = 40
      expect(res.body.data.deliveryFee).toBe(15.0);
      expect(res.body.data.totalAmount).toBe(55.0); // 40 + 15
    });

    it('should calculate Color printing at ₹10.00 per page', async () => {
      const res = await request(app)
        .post('/api/v1/orders/calculate-printing-bill')
        .send({
          userId,
          pageCount: 4,
          copies: 1,
          colorMode: 'COLOR',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.ratePerPage).toBe(10.0);
      expect(res.body.data.subtotal).toBe(40.0); // 4 * 10 = 40
      expect(res.body.data.totalAmount).toBe(55.0); // 40 + 15
    });
  });

  describe('2. Document Upload, Google Drive Storage & Ringing in 2.5km Zone', () => {
    it('should upload image (JPG), store in Google Drive, and dispatch ring to partners', async () => {
      // Simulate fake JPG image bytes
      const fakeImageBytes = Buffer.from('FAKE_JPEG_IMAGE_BINARY_DATA_FOR_PRINTING');

      const res = await request(app)
        .post('/api/v1/orders/printing')
        .attach('file', fakeImageBytes, 'lab_circuit_diagram.jpg')
        .field('userId', userId)
        .field('userName', 'Subham Ghosh')
        .field('userEmail', 'subham@example.com')
        .field('userPhone', '9876543499')
        .field('latitude', 22.5726)
        .field('longitude', 88.3639)
        .field('deliveryAddress', 'Hostel 3, Room 12')
        .field('pageCount', 3)
        .field('copies', 1)
        .field('colorMode', 'BW')
        .field('explanation', 'Print on heavy A4 bond paper with high contrast');

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);

      const order = res.body.data;
      expect(order.orderType).toBe('DOCUMENT_PRINTING');
      expect(order.status).toBe('SEARCHING_PARTNER');
      expect(order.totalAmount).toBe(21.0); // 3 * ₹2 + ₹15 = ₹21

      // Verify Google Drive storage links
      const printing = order.printingDetails;
      expect(printing).toBeDefined();
      expect(printing.fileName).toBe('lab_circuit_diagram.jpg');
      expect(printing.googleDriveFileId).toBeDefined();
      expect(printing.googleDriveViewLink).toContain('drive.google.com/file/d/');
      expect(printing.googleDriveDownloadLink).toContain('drive.google.com/uc?id=');
      expect(printing.fileUrl).toContain('/api/v1/orders/print-document/');
    });
  });

  describe('3. Partner Downloads Document from Google Drive & Online Payment Flow', () => {
    let orderId: string;

    beforeEach(async () => {
      const fakeImageBytes = Buffer.from('PRINT_ME_CLEARLY_JPG_DATA');
      const res = await request(app)
        .post('/api/v1/orders/printing')
        .attach('file', fakeImageBytes, 'assignment_cover.jpg')
        .field('userId', userId)
        .field('latitude', 22.5726)
        .field('longitude', 88.3639)
        .field('deliveryAddress', 'Library Reading Room 3')
        .field('pageCount', 5)
        .field('colorMode', 'COLOR');

      orderId = res.body.data.orderId;

      await request(app)
        .post(`/api/v1/orders/${orderId}/partner-accept`)
        .send({ partnerId: partner1Id });
    });

    it('should allow partner to fetch and download the document for printing', async () => {
      const downloadRes = await request(app).get(`/api/v1/orders/${orderId}/print-document`);

      expect(downloadRes.status).toBe(200);
      expect(downloadRes.headers['content-disposition']).toContain('attachment');
      expect(downloadRes.body.toString()).toContain('PRINT_ME_CLEARLY_JPG_DATA');
    });

    it('should REJECT offline cash payment for printing (online-only enforcement)', async () => {
      const res = await request(app)
        .post(`/api/v1/orders/${orderId}/select-payment`)
        .send({ userId, paymentMode: 'OFFLINE' });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain('require ONLINE payment via Razorpay');
    });

    it('should accept ONLINE Razorpay payment and verify order status', async () => {
      const selectRes = await request(app)
        .post(`/api/v1/orders/${orderId}/select-payment`)
        .send({ userId, paymentMode: 'ONLINE' });

      expect(selectRes.status).toBe(200);
      const razorpayOrderId = selectRes.body.data.razorpayOrderId;

      const razorpayPaymentId = `pay_prn_${Date.now()}`;
      const signature = razorpayService.generateSignature(razorpayOrderId, razorpayPaymentId);

      const verifyRes = await request(app)
        .post(`/api/v1/orders/${orderId}/verify-payment`)
        .send({ razorpayOrderId, razorpayPaymentId, razorpaySignature: signature });

      expect(verifyRes.status).toBe(200);
      expect(verifyRes.body.data.isPaid).toBe(true);
      expect(verifyRes.body.data.status).toBe('PRINTING_IN_PROGRESS');
    });
  });

  describe('4. Full Printing Journey to Arrival Ringing & OTP Verification', () => {
    let orderId: string;

    beforeEach(async () => {
      const fakeDocBytes = Buffer.from('DISSERTATION_FINAL_PRINT');
      const res = await request(app)
        .post('/api/v1/orders/printing')
        .attach('file', fakeDocBytes, 'thesis_abstract.jpg')
        .field('userId', userId)
        .field('userEmail', 'thesis.student@example.com')
        .field('latitude', 22.5726)
        .field('longitude', 88.3639)
        .field('deliveryAddress', 'Hostel 1, Room 44')
        .field('pageCount', 2)
        .field('colorMode', 'BW');

      orderId = res.body.data.orderId;

      await request(app)
        .post(`/api/v1/orders/${orderId}/partner-accept`)
        .send({ partnerId: partner1Id });

      const selectRes = await request(app)
        .post(`/api/v1/orders/${orderId}/select-payment`)
        .send({ userId, paymentMode: 'ONLINE' });

      const rzpOrderId = selectRes.body.data.razorpayOrderId;
      const rzpPayId = `pay_prn_journey_${Date.now()}`;
      const signature = razorpayService.generateSignature(rzpOrderId, rzpPayId);

      await request(app)
        .post(`/api/v1/orders/${orderId}/verify-payment`)
        .send({ razorpayOrderId: rzpOrderId, razorpayPaymentId: rzpPayId, razorpaySignature: signature });
    });

    it('should complete printing flow: print -> out for delivery -> arrival proximity ring -> delivery OTP verified', async () => {
      // 1. Partner finishes printing at xerox shop and moves to delivery
      const stageRes = await request(app)
        .post(`/api/v1/orders/${orderId}/printing/stage`)
        .send({ partnerId: partner1Id, stage: 'OUT_FOR_DELIVERY' });

      expect(stageRes.status).toBe(200);
      expect(stageRes.body.data.status).toBe('DELIVERY_IN_PROGRESS');

      // 2. Partner reaches proximity of user (<150m) -> rings user phone
      const ringRes = await request(app)
        .post(`/api/v1/orders/${orderId}/proximity-ring`)
        .send({
          partnerId: partner1Id,
          partnerLatitude: 22.5727,
          partnerLongitude: 88.3640,
        });

      expect(ringRes.status).toBe(200);
      expect(ringRes.body.data.ringing).toBe(true);

      const Order = getOrderModel();
      const updatedOrder = await Order.findOne({ orderId });
      expect(updatedOrder?.status).toBe('PARTNER_REACHED_DELIVERY');
      const otp = updatedOrder!.deliveryOtp!;
      expect(otp).toBeDefined();

      // 3. Handshake: Partner enters delivery OTP
      const verifyOtpRes = await request(app)
        .post(`/api/v1/orders/${orderId}/verify-delivery-otp`)
        .send({ partnerId: partner1Id, otp });

      expect(verifyOtpRes.status).toBe(200);
      expect(verifyOtpRes.body.data.status).toBe('DELIVERED');

      // 4. Partner wallet credited with delivery earnings
      const PartnerWallet = getPartnerWalletModel();
      const wallet = await PartnerWallet.findOne({ partnerId: partner1Id });
      expect(wallet?.virtualBalance).toBe(15.0);
    });
  });
});
