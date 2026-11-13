import nodemailer, { Transporter } from 'nodemailer';
import { env } from '../config/env';
import { logger } from '../config/logger';

export interface EmailOptions {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface SentEmailRecord extends EmailOptions {
  sentAt: Date;
}

class EmailService {
  private transporter: Transporter | null = null;
  public mockInbox: SentEmailRecord[] = [];

  constructor() {
    this.initializeTransporter();
  }

  private initializeTransporter(): void {
    if (env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS) {
      try {
        const isGmail = env.SMTP_HOST.toLowerCase().includes('gmail');
        const cleanPass = env.SMTP_PASS.replace(/\s+/g, '');

        this.transporter = nodemailer.createTransport(
          isGmail
            ? {
                service: 'gmail',
                auth: {
                  user: env.SMTP_USER,
                  pass: cleanPass,
                },
              }
            : {
                host: env.SMTP_HOST,
                port: env.SMTP_PORT,
                secure: env.SMTP_SECURE,
                auth: {
                  user: env.SMTP_USER,
                  pass: cleanPass,
                },
              }
        );
        logger.info(
          `SMTP Transporter initialized for ${isGmail ? 'Gmail Service' : `${env.SMTP_HOST}:${env.SMTP_PORT}`}`
        );
      } catch (err: any) {
        logger.warn(`Failed to initialize SMTP transporter: ${err.message}. Using mock fallback.`);
      }
    } else {
      logger.info('SMTP not fully configured or in test mode. Emails will be logged to memory/console.');
    }
  }

  /**
   * Verify SMTP credentials and server handshake
   */
  async verifyConnection(): Promise<boolean> {
    if (!this.transporter) {
      logger.warn('Cannot verify SMTP connection: Transporter is not initialized.');
      return false;
    }
    try {
      await this.transporter.verify();
      logger.info('SMTP connection successfully verified with Gmail mail server.');
      return true;
    } catch (err: any) {
      logger.error(`SMTP verification failed: ${err.message}`);
      return false;
    }
  }

  /**
   * Generic send email method with error boundary and test mock capture
   */
  async sendMail(options: EmailOptions): Promise<boolean> {
    const record: SentEmailRecord = {
      ...options,
      sentAt: new Date(),
    };

    this.mockInbox.push(record);
    if (this.mockInbox.length > 100) {
      this.mockInbox.shift();
    }

    if (this.transporter && process.env.NODE_ENV !== 'test') {
      try {
        await this.transporter.sendMail({
          from: env.SMTP_FROM,
          to: options.to,
          subject: options.subject,
          text: options.text,
          html: options.html,
        });
        logger.info(`[EMAIL SENT] To: ${options.to} | Subject: "${options.subject}"`);
        return true;
      } catch (err: any) {
        logger.error(`Error sending email via SMTP to ${options.to}: ${err.message}`);
        return false;
      }
    }

    // Console / test mock fallback
    logger.info(`[MOCK EMAIL DISPATCH] To: ${options.to} | Subject: "${options.subject}"`);
    return true;
  }

  /**
   * Send Cash Pickup OTP Email
   * Dispatched when Partner arrives at user location to collect offline cash
   */
  async sendCashPickupOtpEmail(params: {
    email: string;
    userName?: string;
    orderId: string;
    otp: string;
    partnerName?: string;
    amount: number;
  }): Promise<boolean> {
    const userName = params.userName || 'Valued Customer';
    const partnerName = params.partnerName || 'Your Delivery Partner';
    const subject = `${params.otp} is your Cash Collection OTP for Order ${params.orderId}`;

    const text = `Hi ${userName},\n\n` +
      `${partnerName} has arrived at your location to collect cash payment of ₹${params.amount.toFixed(2)} for Order #${params.orderId}.\n\n` +
      `Your 6-Digit Cash Verification OTP is: ${params.otp}\n\n` +
      `Please hand over the exact cash of ₹${params.amount.toFixed(2)} and share this OTP with the partner once cash is counted.\n` +
      `This code will expire in ${env.OTP_EXPIRES_IN_MINUTES} minutes.\n\n` +
      `Best regards,\nHelping Services Delivery Fleet Team`;

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: #2563eb; margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.5px;">Helping Services</h1>
          <p style="color: #64748b; margin: 4px 0 0 0; font-size: 13px;">Campus & Community Rapid Delivery Fleet</p>
        </div>

        <div style="background-color: #f8fafc; border-left: 4px solid #2563eb; padding: 16px; border-radius: 4px; margin-bottom: 24px;">
          <p style="margin: 0; color: #1e293b; font-size: 15px;">
            <strong>${partnerName}</strong> has arrived at your location to collect cash for <strong>Order #${params.orderId}</strong>.
          </p>
        </div>

        <p style="color: #334155; font-size: 14px; margin-bottom: 8px;">Hi <strong>${userName}</strong>,</p>
        <p style="color: #334155; font-size: 14px; line-height: 1.5; margin-bottom: 20px;">
          Please hand over <strong>₹${params.amount.toFixed(2)}</strong> in cash to the partner and provide this verification code:
        </p>

        <div style="background-color: #eff6ff; border: 2px dashed #3b82f6; padding: 20px; text-align: center; font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #1d4ed8; border-radius: 8px; margin: 24px 0;">
          ${params.otp}
        </div>

        <div style="background-color: #fef2f2; border: 1px solid #fecaca; padding: 12px 16px; border-radius: 6px; margin-bottom: 24px;">
          <p style="margin: 0; color: #991b1b; font-size: 13px;">
            &#9888; <strong>Security Notice:</strong> Only share this code <em>after</em> handing over the cash. Never share OTPs over phone or messaging. Valid for ${env.OTP_EXPIRES_IN_MINUTES} minutes.
          </p>
        </div>

        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
        <p style="color: #94a3b8; font-size: 12px; text-align: center; margin: 0;">
          Helping Services &bull; Secure Real-Time Handshake Architecture
        </p>
      </div>
    `;

    return this.sendMail({ to: params.email, subject, text, html });
  }

  /**
   * Send Delivery Confirmation OTP Email
   * Dispatched when Partner arrives at destination with the user's products
   */
  async sendDeliveryOtpEmail(params: {
    email: string;
    userName?: string;
    orderId: string;
    otp: string;
    partnerName?: string;
  }): Promise<boolean> {
    const userName = params.userName || 'Valued Customer';
    const partnerName = params.partnerName || 'Your Delivery Partner';
    const subject = `${params.otp} is your Final Delivery OTP for Order ${params.orderId}`;

    const text = `Hi ${userName},\n\n` +
      `${partnerName} has arrived with your items for Order #${params.orderId}!\n\n` +
      `Your 6-Digit Final Delivery OTP is: ${params.otp}\n\n` +
      `Please inspect your package and give this code to the partner to complete your order.\n` +
      `This code will expire in ${env.OTP_EXPIRES_IN_MINUTES} minutes.\n\n` +
      `Thank you for choosing Helping Services!`;

    const html = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: auto; padding: 24px; border: 1px solid #e2e8f0; border-radius: 12px; background-color: #ffffff;">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: #16a34a; margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.5px;">Helping Services</h1>
          <p style="color: #64748b; margin: 4px 0 0 0; font-size: 13px;">Campus & Community Rapid Delivery Fleet</p>
        </div>

        <div style="background-color: #f0fdf4; border-left: 4px solid #16a34a; padding: 16px; border-radius: 4px; margin-bottom: 24px;">
          <p style="margin: 0; color: #166534; font-size: 15px;">
            &#128230; <strong>${partnerName}</strong> has arrived outside with your order <strong>#${params.orderId}</strong>!
          </p>
        </div>

        <p style="color: #334155; font-size: 14px; margin-bottom: 8px;">Hi <strong>${userName}</strong>,</p>
        <p style="color: #334155; font-size: 14px; line-height: 1.5; margin-bottom: 20px;">
          Your order has arrived! Receive your package and share the following completion code with your partner:
        </p>

        <div style="background-color: #f0fdf4; border: 2px dashed #22c55e; padding: 20px; text-align: center; font-size: 36px; font-weight: 800; letter-spacing: 8px; color: #15803d; border-radius: 8px; margin: 24px 0;">
          ${params.otp}
        </div>

        <p style="color: #64748b; font-size: 13px; text-align: center; margin-bottom: 24px;">
          This code will expire in <strong>${env.OTP_EXPIRES_IN_MINUTES} minutes</strong>.
        </p>

        <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
        <p style="color: #94a3b8; font-size: 12px; text-align: center; margin: 0;">
          Helping Services &bull; Secure Real-Time Handshake Architecture
        </p>
      </div>
    `;

    return this.sendMail({ to: params.email, subject, text, html });
  }
}

export const emailService = new EmailService();

