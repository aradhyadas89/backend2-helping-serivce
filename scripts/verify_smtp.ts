import { emailService } from '../src/services/email.service';
import { env } from '../src/config/env';
import { logger } from '../src/config/logger';

async function testSmtp() {
  logger.info('========================================================');
  logger.info('--- Verifying Gmail SMTP Server Credentials ---');
  logger.info('========================================================');
  logger.info(`Host: ${env.SMTP_HOST}:${env.SMTP_PORT}`);
  logger.info(`User: ${env.SMTP_USER}`);
  logger.info(`From: ${env.SMTP_FROM}`);
  logger.info(`Secure: ${env.SMTP_SECURE}`);

  try {
    const isVerified = await emailService.verifyConnection();
    if (isVerified) {
      logger.info('✅ SMTP Handshake Successful! Credentials are fully authorized.');
      process.exit(0);
    } else {
      logger.error('❌ SMTP Verification Failed.');
      process.exit(1);
    }
  } catch (err: any) {
    logger.error('❌ SMTP Error:', err);
    process.exit(1);
  }
}

testSmtp();
