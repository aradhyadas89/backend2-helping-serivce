import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';

/**
 * Hash password securely using Node.js scrypt with unique cryptographic salt
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derivedKey}`;
}

/**
 * Verify plaintext password against stored salt:hash in constant time
 */
export function verifyPassword(password: string, storedHash: string): boolean {
  try {
    const [salt, key] = storedHash.split(':');
    if (!salt || !key) return false;

    const keyBuffer = Buffer.from(key, 'hex');
    const derivedKey = crypto.scryptSync(password, salt, 64);

    return crypto.timingSafeEqual(keyBuffer, derivedKey);
  } catch {
    return false;
  }
}

/**
 * Generate authenticated JWT Bearer token for Partner portal
 */
export function generatePartnerToken(partner: {
  partnerId: string;
  email: string;
  name: string;
}): string {
  return jwt.sign(
    {
      userId: partner.partnerId,
      partnerId: partner.partnerId,
      email: partner.email,
      name: partner.name,
      role: 'partner',
    },
    env.JWT_SECRET,
    { expiresIn: '7d' }
  );
}
