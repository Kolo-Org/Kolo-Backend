import crypto from 'crypto';
import { config } from '../config/env';

const ALGORITHM = 'aes-256-gcm';

function getKeyBuffer(version?: number): Buffer {
    const keyVersion = version === undefined ? 1 : version;

    if (!Number.isInteger(keyVersion) || keyVersion < 1) {
        throw new Error(`Invalid encryption key version: ${keyVersion}`);
    }

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

interface EncryptedFieldBlob {
    c: string; // ciphertext
    iv: string;
    tag: string;
    v: number; // key version
}

function getHmacKeyBuffer(): Buffer {
    const keyString = config.HMAC_KEY;

    if (!keyString || !/^[\da-f]{64}$/i.test(keyString)) {
        throw new Error('HMAC_KEY is not set or must be a 64-character hex string (32 bytes).');
    }

    return Buffer.from(keyString, 'hex');
}

// Deterministic hash used for lookups on encrypted phone numbers. The HMAC key
// must be different from the encryption keys so a leak of one does not enable
// the other operation.
export function hmacPhone(phoneNumber: string): string {
    const key = getHmacKeyBuffer();

    try {
        return crypto.createHmac('sha256', key).update(phoneNumber, 'utf8').digest('hex');
    } finally {
        key.fill(0);
    }
}

// Single-column encoding of an AES-256-GCM encrypted value. The whole JSON
// blob goes into the database column, mirroring how stellarWallet is stored.
export function encryptField(plaintext: string): string {
    const { encryptedText, iv, authTag, keyVersion } = encrypt(plaintext);

    return JSON.stringify({ c: encryptedText, iv, tag: authTag, v: keyVersion } satisfies EncryptedFieldBlob);
}

export function decryptField(blob: string): string {
    const parsed = JSON.parse(blob) as EncryptedFieldBlob;
    return decrypt(parsed.c, parsed.iv, parsed.tag, parsed.v);
}

export function isEncryptedFieldBlob(value: unknown): value is string {
    if (typeof value !== 'string' || !value.startsWith('{')) {
        return false;
    }
    try {
        const parsed = JSON.parse(value) as Partial<EncryptedFieldBlob>;
        return typeof parsed.c === 'string' && typeof parsed.iv === 'string' && typeof parsed.tag === 'string';
    } catch {
        return false;
    }
}
