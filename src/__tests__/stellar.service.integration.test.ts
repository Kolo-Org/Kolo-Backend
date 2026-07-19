import { StellarService } from '../services/stellar.service';

jest.mock('../lib/redis', () => ({
    redisClient: {
        get: jest.fn().mockResolvedValue(null),
        set: jest.fn().mockResolvedValue('OK'),
        scan: jest.fn().mockResolvedValue(['0', []]),
        quit: jest.fn()
    }
}));

import { config } from '../config/env';

config.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

// Increase timeout for integration tests since they hit the real Stellar Testnet
jest.setTimeout(30000);

describe('StellarService Integration', () => {
    let stellarService: StellarService;
    let testPublicKey: string;

    beforeAll(async () => {
        stellarService = new StellarService();
        
        // 1. Generate a new wallet for testing
        const wallet = stellarService.generateWallet();
        testPublicKey = wallet.publicKey;

        // 2. Fund the wallet on the testnet using friendbot
        // This will create the initial account creation transaction on the ledger
        await stellarService.fundTestnetAccount(testPublicKey);
        
        // Wait a few seconds for the transaction to be fully processed by Horizon
        await new Promise(resolve => setTimeout(resolve, 3000));
    });

    afterAll(async () => {
        // Clean up any open connections (like redis) if needed
        const { redisClient } = require('../lib/redis');
        await redisClient.quit();
    });

    describe('getTransactionHistory', () => {
        it('should fetch real transactions and support pagination from the testnet', async () => {
            // First page (default limit is 10, but let's request 1 to test pagination easily)
            const resultPage1 = await stellarService.getTransactionHistory(testPublicKey, undefined, 1);
            
            expect(resultPage1).toBeDefined();
            expect(Array.isArray(resultPage1.transactions)).toBe(true);
            expect(resultPage1.transactions.length).toBeGreaterThan(0);
            
            // The very first transaction for a new account is usually the account creation/funding
            const tx = resultPage1.transactions[0];
            expect(tx).toHaveProperty('hash');
            expect(tx).toHaveProperty('type');
            expect(tx).toHaveProperty('amount');
            expect(tx).toHaveProperty('date');
            
            // Check pagination cursor
            expect(resultPage1.nextCursor).toBeDefined();

            // Note: Since we only funded the account once, there might only be 1 transaction.
            // If there's a nextCursor, we can try to fetch it, but it might return empty.
            if (resultPage1.nextCursor) {
                const resultPage2 = await stellarService.getTransactionHistory(testPublicKey, resultPage1.nextCursor, 1);
                expect(resultPage2).toBeDefined();
                expect(Array.isArray(resultPage2.transactions)).toBe(true);
            }
        });

        it('should return empty list for an unfunded account', async () => {
            const unfundedWallet = stellarService.generateWallet();
            
            // Should not throw, just return empty list or handle 404 gracefully
            try {
                const result = await stellarService.getTransactionHistory(unfundedWallet.publicKey);
                expect(result.transactions.length).toBe(0);
            } catch (error: any) {
                // If it throws instead of returning empty, assert the error
                expect(error.message).toMatch(/No transaction history/i);
            }
        });
    });
});
