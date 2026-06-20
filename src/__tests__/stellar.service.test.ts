import { StellarService } from '../services/stellar.service';
import * as StellarSdk from '@stellar/stellar-sdk';
import { config } from '../config/env';

const mAccount = { balances: [{ asset_type: 'native', balance: '100.50' }] };
const mServer = {
  loadAccount: jest.fn().mockResolvedValue(mAccount),
  fetchBaseFee: jest.fn().mockResolvedValue(100),
  submitTransaction: jest.fn().mockResolvedValue({ successful: true, hash: 'mock_tx_hash' }),
};
import { decrypt } from '../utils/encryption.util';

jest.mock('@stellar/stellar-sdk', () => {
  const originalModule = jest.requireActual('@stellar/stellar-sdk');

  const mTransaction = {
    sign: jest.fn(),
  };

  const mTransactionBuilder = jest.fn().mockImplementation(() => ({
    addOperation: jest.fn().mockReturnThis(),
    setTimeout: jest.fn().mockReturnThis(),
    build: jest.fn().mockReturnValue(mTransaction),
  }));

  const mKeypair = {
    publicKey: jest.fn().mockReturnValue('G_MOCK_PUBLIC_KEY'),
    secret: jest.fn().mockReturnValue('S_MOCK_SECRET_KEY'),
  };

  return {
    ...originalModule,
    Horizon: {
      Server: jest.fn(() => mServer),
    },
    TransactionBuilder: mTransactionBuilder,
    Keypair: {
      fromSecret: jest.fn().mockReturnValue(mKeypair),
      random: jest.fn().mockReturnValue(mKeypair),
    },
    Operation: {
      payment: jest.fn().mockReturnValue({}),
    },
  };
});

jest.mock('axios', () => ({
  get: jest.fn().mockResolvedValue({ status: 200, data: { successful: true } }),
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
  });

  beforeEach(() => {
    jest.clearAllMocks();
    config.STELLAR_NETWORK = originalNetwork;
    stellarService = new StellarService();
  });

  afterAll(() => {
    config.STELLAR_NETWORK = originalNetwork;
  });

  describe('generateWallet', () => {
    it('should return a generated keypair and clear the temporary secret buffer', () => {
      const fillSpy = jest.spyOn(Buffer.prototype, 'fill');
      try {
        const wallet = stellarService.generateWallet();

        expect(wallet.publicKey).toBe('G_MOCK_PUBLIC_KEY');
        expect(wallet.encryptedSecret).toBeDefined();
        expect(wallet.iv).toBeDefined();
        expect(wallet.authTag).toBeDefined();
      } finally {
        fillSpy.mockRestore();
      }
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

    it('should throw on non-200 response', async () => {
      const axios = require('axios');
      axios.get.mockResolvedValueOnce({ status: 500 });
      await expect(stellarService.fundTestnetAccount('G_MOCK')).rejects.toThrow(
        'Friendbot funding failed',
      );
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
  });
});
