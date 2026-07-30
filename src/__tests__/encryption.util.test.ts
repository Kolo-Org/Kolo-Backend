import { encrypt, decrypt } from '../utils/encryption.util';
import { config } from '../config/env';

describe('encryption.util', () => {
    let originalConfig: typeof config;

    beforeEach(() => {
        originalConfig = { ...config };
        config.ENCRYPTION_KEYS = {
            1: '1111111111111111111111111111111111111111111111111111111111111111',
            2: '2222222222222222222222222222222222222222222222222222222222222222',
        };
        config.CURRENT_ENCRYPTION_KEY_VERSION = 2;
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
        expect(decrypted).toBe(text);
    });

    it('decrypts legacy v1 data when keyVersion is not provided', () => {
        config.CURRENT_ENCRYPTION_KEY_VERSION = 1;
        const text = 'legacy secret';
        const result = encrypt(text);
        
        config.CURRENT_ENCRYPTION_KEY_VERSION = 2; // System upgraded

        // Decrypt without specifying keyVersion (legacy fallback)
        const decrypted = decrypt(result.encryptedText, result.iv, result.authTag);
        expect(decrypted).toBe(text);
    });

    it('decrypts successfully with explicit v1 key', () => {
        config.CURRENT_ENCRYPTION_KEY_VERSION = 1;
        const text = 'legacy secret explicit';
        const result = encrypt(text);

        const decrypted = decrypt(result.encryptedText, result.iv, result.authTag, 1);
        expect(decrypted).toBe(text);
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
});
