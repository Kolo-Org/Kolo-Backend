import crypto from 'crypto';
import { config } from '../config/env';

const ALGORITHM = 'aes-256-gcm';

export function encrypt(text: string) {
    if (!config.ENCRYPTION_KEY || config.ENCRYPTION_KEY.length !== 64) {
        throw new Error('ENCRYPTION_KEY is not set or must be a 64-character hex string (32 bytes).');
    }

    const key = Buffer.from(config.ENCRYPTION_KEY, 'hex');
    const iv = crypto.randomBytes(12); // 96-bit IV is standard for GCM
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag().toString('hex');

    return {
        encryptedText: encrypted,
        iv: iv.toString('hex'),
        authTag: authTag,
    };
}

export function decrypt(encryptedText: string, ivHex: string, authTagHex: string): string {
    if (!config.ENCRYPTION_KEY || config.ENCRYPTION_KEY.length !== 64) {
        throw new Error('ENCRYPTION_KEY is not set or must be a 64-character hex string (32 bytes).');
    }

    const key = Buffer.from(config.ENCRYPTION_KEY, 'hex');
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
}
