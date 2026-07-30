import crypto from 'crypto';
import { config } from '../config/env';

const ALGORITHM = 'aes-256-gcm';

function getKeyBuffer(version?: number): Buffer {
    const keyVersion = version || 1;
    let keyString = config.ENCRYPTION_KEYS[keyVersion];
    
    if (!keyString && keyVersion === 1) {
        keyString = config.ENCRYPTION_KEY;
    }

    if (!keyString || keyString.length !== 64) {
        throw new Error(`Encryption key for version ${keyVersion} is not set or must be a 64-character hex string (32 bytes).`);
    }

    return Buffer.from(keyString, 'hex');
}

export function encrypt(text: string) {
    const keyVersion = config.CURRENT_ENCRYPTION_KEY_VERSION;
    const key = getKeyBuffer(keyVersion);
    let cipher: crypto.CipherGCM | undefined;

    try {
        const iv = crypto.randomBytes(12); // 96-bit IV is standard for GCM
        cipher = crypto.createCipheriv(ALGORITHM, key, iv);

        let encrypted = cipher.update(text, 'utf8', 'hex');
        encrypted += cipher.final('hex');

        const authTag = cipher.getAuthTag().toString('hex');

        return {
            encryptedText: encrypted,
            iv: iv.toString('hex'),
            authTag: authTag,
            keyVersion: keyVersion
        };
    } finally {
        key.fill(0);
    }
}

export function decrypt(encryptedText: string, ivHex: string, authTagHex: string, keyVersion?: number): string {
    const key = getKeyBuffer(keyVersion);
    let decipher: crypto.DecipherGCM | undefined;

    try {
        const iv = Buffer.from(ivHex, 'hex');
        const authTag = Buffer.from(authTagHex, 'hex');

        decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(authTag);

        let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
        decrypted += decipher.final('utf8');

        return decrypted;
    } finally {
        key.fill(0);
    }
}
