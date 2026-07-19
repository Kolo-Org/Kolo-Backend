import { StellarService } from '../services/stellar.service';
import * as StellarSdk from '@stellar/stellar-sdk';
import { config } from '../config/env';
import { decrypt } from '../utils/encryption.util';

const mAccount = { balances: [{ asset_type: 'native', balance: '100.50' }] };
const mServer = {
    loadAccount: jest.fn().mockResolvedValue(mAccount),
    fetchBaseFee: jest.fn().mockResolvedValue(100),
    submitTransaction: jest.fn().mockResolvedValue({ successful: true, hash: 'mock_tx_hash' })
};

jest.mock('../lib/redis', () => ({
    redisClient: {
        get: jest.fn(),
        set: jest.fn(),
        del: jest.fn(),
        keys: jest.fn().mockResolvedValue([]),
        scan: jest.fn()
    }
}));
const { redisClient } = require('../lib/redis');
const mockRedisGet = redisClient.get as jest.Mock;
const mockRedisSet = redisClient.set as jest.Mock;
const mockRedisDel = redisClient.del as jest.Mock;
const mockRedisKeys = redisClient.keys as jest.Mock;
const mockRedisScan = redisClient.scan as jest.Mock;
mockRedisScan.mockResolvedValue(['0', []]);

jest.mock('@stellar/stellar-sdk', () => {
    const originalModule = jest.requireActual('@stellar/stellar-sdk');

    const mTransaction = { sign: jest.fn() };

    const mTransactionBuilder = jest.fn().mockImplementation(() => ({
        addOperation: jest.fn().mockReturnThis(),
        setTimeout: jest.fn().mockReturnThis(),
        build: jest.fn().mockReturnValue(mTransaction)
    }));

    const mKeypair = {
        publicKey: jest.fn().mockReturnValue('G_MOCK_PUBLIC_KEY'),
        secret: jest.fn().mockReturnValue('S_MOCK_SECRET_KEY')
    };

    return {
        ...originalModule,
        Horizon: { Server: jest.fn(() => mServer) },
        TransactionBuilder: mTransactionBuilder,
        Keypair: {
            fromSecret: jest.fn().mockReturnValue(mKeypair),
            random: jest.fn().mockReturnValue(mKeypair)
        },
        Operation: { payment: jest.fn().mockReturnValue({}) }
    };
});

jest.mock('axios', () => ({
    get: jest.fn().mockResolvedValue({ status: 200, data: { successful: true } })
}));

describe('StellarService', () => {
    let stellarService: StellarService;
    const originalNetwork = config.STELLAR_NETWORK;
    const originalKey = config.ENCRYPTION_KEY;

    beforeAll(() => {
        config.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    });

    afterAll(() => {
        config.ENCRYPTION_KEY = originalKey;
        config.STELLAR_NETWORK = originalNetwork;
    });

    beforeEach(() => {
        jest.clearAllMocks();
        config.STELLAR_NETWORK = originalNetwork;
        stellarService = new StellarService();
        mockRedisKeys.mockResolvedValue([]);
    });

    describe('generateWallet', () => {
        it('should return a generated keypair with encrypted secret', () => {
            const wallet = stellarService.generateWallet();

            expect(wallet.publicKey).toBe('G_MOCK_PUBLIC_KEY');
            expect(wallet.encryptedSecret).toBeDefined();
            expect(wallet.iv).toBeDefined();
            expect(wallet.authTag).toBeDefined();

            const decrypted = decrypt(wallet.encryptedSecret, wallet.iv, wallet.authTag);
            expect(decrypted).toBe('S_MOCK_SECRET_KEY');
        });
    });

    describe('constructor', () => {
        it('should use the public horizon when configured for mainnet', () => {
            config.STELLAR_NETWORK = 'PUBLIC';
            new StellarService();

            expect(StellarSdk.Horizon.Server).toHaveBeenCalledWith('https://horizon.stellar.org');
        });
    });

    describe('fundTestnetAccount', () => {
        it('should call friendbot api for testnet', async () => {
            const axios = require('axios');
            await stellarService.fundTestnetAccount('G_MOCK');
            expect(axios.get).toHaveBeenCalledWith('https://friendbot.stellar.org?addr=G_MOCK');
        });

        it('should skip friendbot when not on testnet', async () => {
            config.STELLAR_NETWORK = 'PUBLIC';
            stellarService = new StellarService();
            const axios = require('axios');

            await stellarService.fundTestnetAccount('G_MOCK');

            expect(axios.get).not.toHaveBeenCalled();
        });

        it('should log and swallow friendbot failures', async () => {
            const axios = require('axios');
            axios.get.mockResolvedValueOnce({ status: 500 });
            const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
            
            try {
                await stellarService.fundTestnetAccount('G_MOCK');
                expect(consoleSpy).toHaveBeenCalledWith('Friendbot funding failed:', expect.any(Error));
            } finally {
                consoleSpy.mockRestore();
            }
        });
    });

    describe('checkBalance', () => {
        it('should return native balance', async () => {
            const balance = await stellarService.checkBalance('G_MOCK');
            expect(balance).toBe('100.50');
        });

        it('should return zero when no native balance is present', async () => {
            mServer.loadAccount.mockResolvedValueOnce({
                balances: [{ asset_type: 'credit_alphanum4', balance: '17.25' }],
            });

            const balance = await stellarService.checkBalance('G_MOCK');
            expect(balance).toBe('0');
        });

        it('should return a safe error message when the account lookup fails', async () => {
            mServer.loadAccount.mockRejectedValueOnce(new Error('network unavailable'));
            const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

            try {
                const balance = await stellarService.checkBalance('G_MOCK');
                expect(balance).toBe('Error checking balance or account not funded.');
                expect(consoleSpy).toHaveBeenCalledWith('Error checking balance:', expect.any(Error));
            } finally {
                consoleSpy.mockRestore();
            }
        });
    });

    describe('sendPayment', () => {
        it('should submit transaction and return result', async () => {
            const validPublicKey = 'GBBM6BKZPEHWPI3VK3VNKEJEXTMIGNNCE2ZEXSVEEKSJNDYTK2E4QUDE';
            const result = await stellarService.sendPayment('S_MOCK', validPublicKey, '10.0');
            expect(result.successful).toBe(true);
            expect(result.hash).toBe('mock_tx_hash');
        });

        it('should use the public network passphrase when configured for mainnet', async () => {
            config.STELLAR_NETWORK = 'PUBLIC';
            stellarService = new StellarService();

            const validPublicKey = 'GBBM6BKZPEHWPI3VK3VNKEJEXTMIGNNCE2ZEXSVEEKSJNDYTK2E4QUDE';
            await stellarService.sendPayment('S_MOCK', validPublicKey, '10.0');

            expect(StellarSdk.TransactionBuilder).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({
                    networkPassphrase: StellarSdk.Networks.PUBLIC,
                }),
            );
        });

        it('should invalidate redis cache after sendPayment', async () => {
            mockRedisScan.mockResolvedValueOnce(['0', ['tx_history:G_MOCK:page:1']]);
            mockRedisScan.mockResolvedValueOnce(['0', ['tx_history:GBBM6BKZPEHWPI3VK3VNKEJEXTMIGNNCE2ZEXSVEEKSJNDYTK2E4QUDE:page:1']]);
            const validPublicKey = 'GBBM6BKZPEHWPI3VK3VNKEJEXTMIGNNCE2ZEXSVEEKSJNDYTK2E4QUDE';
            await stellarService.sendPayment('S_MOCK', validPublicKey, '10.0');
            expect(mockRedisDel).toHaveBeenCalledWith('tx_history:G_MOCK:page:1');
        });
    });

    describe('getTransactionHistory', () => {
        const mockOpCall = jest.fn();
        const mockTxCall = jest.fn();
        const mockCursor = jest.fn().mockReturnThis();
        const mockLimit = jest.fn().mockReturnThis();
        const mockOrder = jest.fn().mockReturnThis();
        const mockForAccount = jest.fn().mockReturnThis();

        beforeAll(() => {
            (mServer as any).transactions = jest.fn().mockReturnValue({
                forAccount: mockForAccount,
                order: mockOrder,
                limit: mockLimit,
                cursor: mockCursor,
                call: mockTxCall
            });
        });

        it('should return cached result if available', async () => {
            mockRedisGet.mockResolvedValue(JSON.stringify({ transactions: [], nextCursor: null }));
            const result = await stellarService.getTransactionHistory('G_MOCK');
            expect(result.transactions).toEqual([]);
            expect(mockTxCall).not.toHaveBeenCalled();
        });

        it('should fetch from horizon if not cached and cache the result', async () => {
            mockRedisGet.mockResolvedValue(null);
            mockTxCall.mockResolvedValue({
                records: [{
                    id: 'tx1',
                    created_at: '2026-06-25T00:00:00Z',
                    hash: 'HASH123',
                    operations: jest.fn().mockResolvedValue({
                        records: [{ type: 'payment', amount: '10.0', asset_type: 'native', from: 'G_OTHER', to: 'G_MOCK' }]
                    })
                }]
            });
            const result = await stellarService.getTransactionHistory('G_MOCK');
            expect(result.transactions.length).toBe(1);
            expect(result.transactions[0].type).toBe('payment received');
            expect(result.transactions[0].amount).toBe('10.0');
            expect(result.transactions[0].asset).toBe('XLM');
            expect(result.transactions[0].counterparty).toBe('G_OTHER');
            expect(mockRedisSet).toHaveBeenCalledWith('tx_history:G_MOCK:page:1', expect.any(String), 'EX', 300);
        });

        it('should return 404 formatted error if wallet not funded', async () => {
            mockRedisGet.mockResolvedValue(null);
            mockTxCall.mockRejectedValue({ response: { status: 404 } });
            await expect(stellarService.getTransactionHistory('G_MOCK')).rejects.toThrow(/funded yet/);
        });
    });
});
