import { StellarService } from '../services/stellar.service';
import * as StellarSdk from '@stellar/stellar-sdk';
import { config } from '../config/env';
import { decrypt } from '../utils/encryption.util';

jest.mock('@stellar/stellar-sdk', () => {
    const originalModule = jest.requireActual('@stellar/stellar-sdk');
    
    const mAccount = { balances: [{ asset_type: 'native', balance: '100.50' }] };
    const mServer = {
        loadAccount: jest.fn().mockResolvedValue(mAccount),
        fetchBaseFee: jest.fn().mockResolvedValue(100),
        submitTransaction: jest.fn().mockResolvedValue({ successful: true, hash: 'mock_tx_hash' })
    };

    const mTransaction = {
        sign: jest.fn(),
    };
    
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
        Horizon: {
            Server: jest.fn(() => mServer)
        },
        TransactionBuilder: mTransactionBuilder,
        Keypair: {
            fromSecret: jest.fn().mockReturnValue(mKeypair),
            random: jest.fn().mockReturnValue(mKeypair)
        },
        Operation: {
            payment: jest.fn().mockReturnValue({})
        }
    };
});

jest.mock('axios', () => ({
    get: jest.fn().mockResolvedValue({ data: { successful: true } })
}));

describe('StellarService', () => {
    let stellarService: StellarService;
    const originalKey = config.ENCRYPTION_KEY;

    beforeAll(() => {
        config.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    });

    afterAll(() => {
        config.ENCRYPTION_KEY = originalKey;
    });

    beforeEach(() => {
        jest.clearAllMocks();
        stellarService = new StellarService();
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

    describe('fundTestnetAccount', () => {
        it('should call friendbot api for testnet', async () => {
            const axios = require('axios');
            await stellarService.fundTestnetAccount('G_MOCK');
            expect(axios.get).toHaveBeenCalledWith('https://friendbot.stellar.org?addr=G_MOCK');
        });
    });

    describe('checkBalance', () => {
        it('should return native balance', async () => {
            const balance = await stellarService.checkBalance('G_MOCK');
            expect(balance).toBe('100.50');
        });
    });

    describe('sendPayment', () => {
        it('should submit transaction and return result', async () => {
            const validPublicKey = 'GBBM6BKZPEHWPI3VK3VNKEJEXTMIGNNCE2ZEXSVEEKSJNDYTK2E4QUDE';
            const result = await stellarService.sendPayment('S_MOCK', validPublicKey, '10.0');
            expect(result.successful).toBe(true);
            expect(result.hash).toBe('mock_tx_hash');
        });
    });
});
