import { encrypt, decrypt, encryptBuffer, encryptField, decryptField, hmacPhone, isEncryptedFieldBlob } from '../utils/encryption.util';
import { config } from '../config/env';

const TEST_HMAC_KEY = '3333333333333333333333333333333333333333333333333333333333333333';

describe('encryption.util', () => {
    let originalConfig: typeof config;

    beforeEach(() => {
        originalConfig = { ...config };
        config.ENCRYPTION_KEYS = {
            1: '1111111111111111111111111111111111111111111111111111111111111111',
            2: '2222222222222222222222222222222222222222222222222222222222222222',
        };
        config.CURRENT_ENCRYPTION_KEY_VERSION = 2;
        config.HMAC_KEY = TEST_HMAC_KEY;
    });

    afterEach(() => {
        Object.assign(config, originalConfig);
    });

    it('encrypts using the current key version', () => {
        const text = 'my super secret seed phrase';
        const result = encrypt(text);

        expect(result.keyVersion).toBe(2);
        expect(result.encryptedText).toBeDefined();
        expect(result.iv).toBeDefined();
        expect(result.authTag).toBeDefined();

        const decrypted = decrypt(result.encryptedText, result.iv, result.authTag, result.keyVersion);
        expect(decrypted).toBeInstanceOf(Buffer);
        expect(decrypted.toString('utf8')).toBe(text);
    });

    it('decrypts legacy v1 data when keyVersion is not provided', () => {
        config.CURRENT_ENCRYPTION_KEY_VERSION = 1;
        const text = 'legacy secret';
        const result = encrypt(text);
        
        config.CURRENT_ENCRYPTION_KEY_VERSION = 2; // System upgraded

        // Decrypt without specifying keyVersion (legacy fallback)
        const decrypted = decrypt(result.encryptedText, result.iv, result.authTag);
        expect(decrypted).toBeInstanceOf(Buffer);
        expect(decrypted.toString('utf8')).toBe(text);
    });

    it('decrypts successfully with explicit v1 key', () => {
        config.CURRENT_ENCRYPTION_KEY_VERSION = 1;
        const text = 'legacy secret explicit';
        const result = encrypt(text);

        const decrypted = decrypt(result.encryptedText, result.iv, result.authTag, 1);
        expect(decrypted).toBeInstanceOf(Buffer);
        expect(decrypted.toString('utf8')).toBe(text);
    });

    it('fails to decrypt if the wrong version is supplied', () => {
        const text = 'secret data';
        const result = encrypt(text); // encrypted with v2

        expect(() => {
            decrypt(result.encryptedText, result.iv, result.authTag, 1); // try to decrypt with v1
        }).toThrow();
    });

    it('fails to decrypt if key version is missing from config', () => {
        expect(() => {
            decrypt('dummy', 'dummy', 'dummy', 99);
        }).toThrow('Encryption key for version 99 is not set');
    });

    it('encryptBuffer encrypts a Buffer and decrypt returns Buffer', () => {
        const data = Buffer.from('test secret data for buffer encryption');
        const result = encryptBuffer(data);

        expect(result.keyVersion).toBe(2);
        expect(result.encryptedText).toBeDefined();
        expect(result.iv).toBeDefined();
        expect(result.authTag).toBeDefined();

        const decrypted = decrypt(result.encryptedText, result.iv, result.authTag, result.keyVersion);
        expect(decrypted).toBeInstanceOf(Buffer);
        expect(decrypted).toEqual(data);
    });

    it('decrypt returns a Buffer that can be zeroed', () => {
        const text = 'secret to be zeroed';
        const result = encrypt(text);
        const decrypted = decrypt(result.encryptedText, result.iv, result.authTag, result.keyVersion);

        expect(decrypted).toBeInstanceOf(Buffer);
        expect(decrypted.length).toBeGreaterThan(0);

        // Zero the buffer
        decrypted.fill(0);
        expect(decrypted.every(b => b === 0)).toBe(true);
    });

    describe('field-level helpers (phone number encryption at rest)', () => {
        it('roundtrips a phone number through encryptField/decryptField', () => {
            const phone = '+2348012345678';
            const blob = encryptField(phone);

            expect(isEncryptedFieldBlob(blob)).toBe(true);
            expect(blob).not.toContain(phone);
            expect(decryptField(blob)).toBe(phone);
        });

        it('produces different ciphertext for the same input (per-field IV)', () => {
            const blob1 = encryptField('+2348012345678');
            const blob2 = encryptField('+2348012345678');

            expect(blob1).not.toBe(blob2);
            expect(decryptField(blob1)).toBe(decryptField(blob2));
        });

        it('rejects values that are not encrypted blobs', () => {
            expect(isEncryptedFieldBlob('+2348012345678')).toBe(false);
            expect(isEncryptedFieldBlob('not json {')).toBe(false);
            expect(isEncryptedFieldBlob('{"c":1}')).toBe(false);
        });

        it('computes a deterministic HMAC for lookups', () => {
            const hash1 = hmacPhone('+2348012345678');
            const hash2 = hmacPhone('+2348012345678');

            expect(hash1).toBe(hash2);
            expect(hash1).not.toContain('+2348012345678');
        });

        it('produces different hashes for different numbers', () => {
            expect(hmacPhone('+2348012345678')).not.toBe(hmacPhone('+2348098765432'));
        });

        it('uses the HMAC key, not the encryption key', () => {
            config.HMAC_KEY = '3333333333333333333333333333333333333333333333333333333333333333';
            const withHmacKey = hmacPhone('+2348012345678');

            config.HMAC_KEY = '4444444444444444444444444444444444444444444444444444444444444444';
            const withOtherKey = hmacPhone('+2348012345678');

            expect(withHmacKey).not.toBe(withOtherKey);
        });

        it('fails when HMAC_KEY is not set', () => {
            config.HMAC_KEY = '';
            expect(() => hmacPhone('+2348012345678')).toThrow('HMAC_KEY is not set');
        });
    });
});
