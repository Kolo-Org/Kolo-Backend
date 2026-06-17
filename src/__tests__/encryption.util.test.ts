import { encrypt, decrypt } from '../utils/encryption.util';
import { config } from '../config/env';

describe('Encryption Utility', () => {
    const originalKey = config.ENCRYPTION_KEY;

    beforeAll(() => {
        // Set a dummy 32-byte hex key for testing (64 hex characters)
        config.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    });

    afterAll(() => {
        config.ENCRYPTION_KEY = originalKey;
    });

    it('should successfully encrypt and decrypt a string', () => {
        const secret = 'SAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
        const { encryptedText, iv, authTag } = encrypt(secret);

        expect(encryptedText).toBeDefined();
        expect(iv).toBeDefined();
        expect(authTag).toBeDefined();
        expect(encryptedText).not.toEqual(secret);

        const decrypted = decrypt(encryptedText, iv, authTag);
        expect(decrypted).toEqual(secret);
    });

    it('should produce different ciphertexts for the same plaintext due to random IV', () => {
        const secret = 'SAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
        const result1 = encrypt(secret);
        const result2 = encrypt(secret);

        expect(result1.encryptedText).not.toEqual(result2.encryptedText);
        expect(result1.iv).not.toEqual(result2.iv);
    });

    it('should throw an error if the authTag is tampered with', () => {
        const secret = 'SAXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';
        const { encryptedText, iv, authTag } = encrypt(secret);

        // Tamper with authTag by reversing it
        const tamperedAuthTag = authTag.split('').reverse().join('');
        // Ensure we actually changed it, if it's a palindrome we just replace first char
        const finalAuthTag = tamperedAuthTag === authTag ? authTag.replace('0', '1') : tamperedAuthTag;

        expect(() => {
            decrypt(encryptedText, iv, finalAuthTag);
        }).toThrow();
    });

    it('should throw an error if ENCRYPTION_KEY is not set or invalid length', () => {
        config.ENCRYPTION_KEY = 'shortkey';
        expect(() => encrypt('test')).toThrow('ENCRYPTION_KEY is not set or must be a 64-character hex string (32 bytes).');
        expect(() => decrypt('text', 'iv', 'tag')).toThrow('ENCRYPTION_KEY is not set or must be a 64-character hex string (32 bytes).');
    });
});
