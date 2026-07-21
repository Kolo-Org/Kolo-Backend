import { UserService } from '../services/user.service';
import { PrismaClient } from '@prisma/client';
import { StellarService, InsufficientReserveError } from '../services/stellar.service';
import { WhatsAppService } from '../services/whatsapp.service';
import { config } from '../config/env';

// Mock the modules
jest.mock('../lib/redis', () => ({
    redisClient: {
        get: jest.fn(),
        set: jest.fn(),
        del: jest.fn()
    }
}));
const { redisClient } = require('../lib/redis');
const mockRedisGet = redisClient.get as jest.Mock;
const mockRedisSet = redisClient.set as jest.Mock;

jest.mock('@prisma/client', () => {
    const mPrismaClient = {
        user: {
            findUnique: jest.fn(),
            findFirst: jest.fn(),
            create: jest.fn(),
        },
    };
    return { PrismaClient: jest.fn(() => mPrismaClient) };
});

jest.mock('../services/stellar.service', () => {
    const actual = jest.requireActual('../services/stellar.service');
    const mStellarService = {
        generateWallet: jest.fn(() => ({
            publicKey: 'G_MOCK_PUBLIC_KEY',
            encryptedSecret: 'ENC_SECRET',
            iv: 'IV',
            authTag: 'TAG'
        })),
        fundTestnetAccount: jest.fn().mockResolvedValue(true),
        createTrustline: jest.fn().mockResolvedValue(undefined),
    };
    return { ...actual, StellarService: jest.fn(() => mStellarService) };
});

jest.mock('../services/whatsapp.service', () => {
    const mWhatsAppService = { sendMessage: jest.fn().mockResolvedValue(true) };
    return { WhatsAppService: jest.fn(() => mWhatsAppService) };
});

jest.mock('../utils/encryption.util', () => ({
    decrypt: jest.fn().mockReturnValue('S_MOCK_SECRET'),
}));

jest.mock('../services/locale.service', () => ({
    t: (key: string) => (key === 'wallet.usdc_trustline_low_reserve' ? 'You need at least 2 XLM in your wallet to enable USDC.' : key),
}));

describe('UserService', () => {
    let userService: UserService;
    let prismaClientMock: any;
    let stellarServiceMock: any;
    let whatsappServiceMock: any;
    const originalIssuer = config.USDC_ISSUER_PUBLIC_KEY;

    beforeEach(() => {
        jest.clearAllMocks();
        config.USDC_ISSUER_PUBLIC_KEY = originalIssuer;
        userService = new UserService();
        prismaClientMock = new PrismaClient();
        stellarServiceMock = new StellarService();
        whatsappServiceMock = new WhatsAppService();
    });

    afterAll(() => {
        config.USDC_ISSUER_PUBLIC_KEY = originalIssuer;
    });

    describe('getOrCreateUser', () => {
        it('should return existing user if found', async () => {
            const mockUser = { id: '1', phoneNumber: '1234567890' };
            prismaClientMock.user.findUnique.mockResolvedValueOnce(mockUser);

            const result = await userService.getOrCreateUser('1234567890');

            expect(prismaClientMock.user.findUnique).toHaveBeenCalledWith({
                where: { phoneNumber: '1234567890' }
            });
            expect(prismaClientMock.user.create).not.toHaveBeenCalled();
            expect(result).toEqual(mockUser);
        });

        it('should create new user with generated stellar wallet if not found', async () => {
            prismaClientMock.user.findUnique.mockResolvedValueOnce(null);
            const expectedWallet = JSON.stringify({
                publicKey: 'G_MOCK_PUBLIC_KEY',
                encryptedSecret: 'ENC_SECRET',
                iv: 'IV',
                authTag: 'TAG'
            });
            const createdUser = { id: '2', phoneNumber: '0987654321', stellarWallet: expectedWallet };
            prismaClientMock.user.create.mockResolvedValueOnce(createdUser);

            const result = await userService.getOrCreateUser('0987654321');

            expect(stellarServiceMock.generateWallet).toHaveBeenCalled();
            expect(stellarServiceMock.fundTestnetAccount).toHaveBeenCalledWith('G_MOCK_PUBLIC_KEY');
            expect(prismaClientMock.user.create).toHaveBeenCalledWith({
                data: {
                    phoneNumber: '0987654321',
                    language: 'en',
                    stellarWallet: expectedWallet,
                },
            });
            expect(result).toEqual(createdUser);
        });

        it('should handle friendbot funding failure gracefully', async () => {
            prismaClientMock.user.findUnique.mockResolvedValueOnce(null);
            stellarServiceMock.fundTestnetAccount.mockRejectedValueOnce(new Error('Network error'));
            const expectedWallet = JSON.stringify({
                publicKey: 'G_MOCK_PUBLIC_KEY',
                encryptedSecret: 'ENC_SECRET',
                iv: 'IV',
                authTag: 'TAG'
            });
            const createdUser = { id: '3', phoneNumber: '1111111111', stellarWallet: expectedWallet };
            prismaClientMock.user.create.mockResolvedValueOnce(createdUser);

            const result = await userService.getOrCreateUser('1111111111');

            expect(stellarServiceMock.fundTestnetAccount).toHaveBeenCalledWith('G_MOCK_PUBLIC_KEY');
            expect(prismaClientMock.user.create).toHaveBeenCalled();
            expect(result.stellarWallet).toBe(expectedWallet);
        });

        it('should skip trustline creation when USDC_ISSUER_PUBLIC_KEY is not configured', async () => {
            config.USDC_ISSUER_PUBLIC_KEY = '';
            prismaClientMock.user.findUnique.mockResolvedValueOnce(null);
            prismaClientMock.user.create.mockResolvedValueOnce({ id: '4', phoneNumber: '2222222222' });

            await userService.getOrCreateUser('2222222222');

            expect(stellarServiceMock.createTrustline).not.toHaveBeenCalled();
        });

        it('should establish a USDC trustline when USDC_ISSUER_PUBLIC_KEY is configured', async () => {
            config.USDC_ISSUER_PUBLIC_KEY = 'G_USDC_ISSUER';
            prismaClientMock.user.findUnique.mockResolvedValueOnce(null);
            prismaClientMock.user.create.mockResolvedValueOnce({ id: '5', phoneNumber: '3333333333' });

            await userService.getOrCreateUser('3333333333');

            expect(stellarServiceMock.createTrustline).toHaveBeenCalledWith('S_MOCK_SECRET', 'USDC', 'G_USDC_ISSUER');
            expect(whatsappServiceMock.sendMessage).not.toHaveBeenCalled();
        });

        it('should notify the user via WhatsApp when the trustline reserve is insufficient', async () => {
            config.USDC_ISSUER_PUBLIC_KEY = 'G_USDC_ISSUER';
            stellarServiceMock.createTrustline.mockRejectedValueOnce(new InsufficientReserveError());
            prismaClientMock.user.findUnique.mockResolvedValueOnce(null);
            prismaClientMock.user.create.mockResolvedValueOnce({ id: '6', phoneNumber: '4444444444' });

            await userService.getOrCreateUser('4444444444');

            expect(whatsappServiceMock.sendMessage).toHaveBeenCalledWith(
                '4444444444',
                expect.stringContaining('2 XLM'),
            );
        });

        it('should log and continue when trustline creation fails for an unrelated reason', async () => {
            config.USDC_ISSUER_PUBLIC_KEY = 'G_USDC_ISSUER';
            stellarServiceMock.createTrustline.mockRejectedValueOnce(new Error('Horizon is down'));
            prismaClientMock.user.findUnique.mockResolvedValueOnce(null);
            const createdUser = { id: '7', phoneNumber: '5555555555' };
            prismaClientMock.user.create.mockResolvedValueOnce(createdUser);
            const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

            try {
                const result = await userService.getOrCreateUser('5555555555');
                expect(whatsappServiceMock.sendMessage).not.toHaveBeenCalled();
                expect(result).toEqual(createdUser);
            } finally {
                consoleSpy.mockRestore();
            }
        });
    });

    describe('resolveUser', () => {
        it('should resolve by username if target starts with @', async () => {
            prismaClientMock.user.findUnique.mockResolvedValueOnce({ username: 'john' });
            await userService.resolveUser('@john');
            expect(prismaClientMock.user.findUnique).toHaveBeenCalledWith({
                where: { username: 'john' }
            });
        });

        it('should resolve by phone number if target does not start with @', async () => {
            prismaClientMock.user.findUnique.mockResolvedValueOnce({ phoneNumber: '123' });
            await userService.resolveUser('123');
            expect(prismaClientMock.user.findUnique).toHaveBeenCalledWith({
                where: { phoneNumber: '123' }
            });
        });
    });

    describe('getUserByPublicKey', () => {
        const mockPublicKey = 'G_MOCK_PUBLIC_KEY';
        const cacheKey = `address_to_username:${mockPublicKey}`;
        const mockUser = { username: 'testuser', phoneNumber: '1234567890' };

        it('should return cached user on cache hit', async () => {
            mockRedisGet.mockResolvedValueOnce(JSON.stringify(mockUser));

            const result = await userService.getUserByPublicKey(mockPublicKey);

            expect(mockRedisGet).toHaveBeenCalledWith(cacheKey);
            expect(prismaClientMock.user.findFirst).not.toHaveBeenCalled();
            expect(result).toEqual(mockUser);
        });

        it('should fetch from Prisma and cache the result on cache miss', async () => {
            mockRedisGet.mockResolvedValueOnce(null);
            prismaClientMock.user.findFirst.mockResolvedValueOnce(mockUser);

            const result = await userService.getUserByPublicKey(mockPublicKey);

            expect(mockRedisGet).toHaveBeenCalledWith(cacheKey);
            expect(prismaClientMock.user.findFirst).toHaveBeenCalledWith({
                where: { stellarWallet: { contains: mockPublicKey } },
                select: { username: true, phoneNumber: true }
            });
            expect(mockRedisSet).toHaveBeenCalledWith(cacheKey, JSON.stringify(mockUser), 'EX', 3600);
            expect(result).toEqual(mockUser);
        });

        it('should gracefully handle Redis get failure and still fetch from Prisma', async () => {
            mockRedisGet.mockRejectedValueOnce(new Error('Redis connection error'));
            prismaClientMock.user.findFirst.mockResolvedValueOnce(mockUser);
            
            // Suppress console.error for this test
            const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

            const result = await userService.getUserByPublicKey(mockPublicKey);

            expect(mockRedisGet).toHaveBeenCalledWith(cacheKey);
            expect(prismaClientMock.user.findFirst).toHaveBeenCalled();
            expect(mockRedisSet).toHaveBeenCalledWith(cacheKey, JSON.stringify(mockUser), 'EX', 3600);
            expect(result).toEqual(mockUser);

            consoleSpy.mockRestore();
        });

        it('should gracefully handle Redis set failure after fetching from Prisma', async () => {
            mockRedisGet.mockResolvedValueOnce(null);
            prismaClientMock.user.findFirst.mockResolvedValueOnce(mockUser);
            mockRedisSet.mockRejectedValueOnce(new Error('Redis connection error'));
            
            // Suppress console.error for this test
            const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

            const result = await userService.getUserByPublicKey(mockPublicKey);

            expect(mockRedisGet).toHaveBeenCalledWith(cacheKey);
            expect(prismaClientMock.user.findFirst).toHaveBeenCalled();
            expect(mockRedisSet).toHaveBeenCalledWith(cacheKey, JSON.stringify(mockUser), 'EX', 3600);
            expect(result).toEqual(mockUser);

            consoleSpy.mockRestore();
        });
        
        it('should return null if user is not found in cache or DB', async () => {
            mockRedisGet.mockResolvedValueOnce(null);
            prismaClientMock.user.findFirst.mockResolvedValueOnce(null);

            const result = await userService.getUserByPublicKey(mockPublicKey);

            expect(mockRedisGet).toHaveBeenCalledWith(cacheKey);
            expect(prismaClientMock.user.findFirst).toHaveBeenCalled();
            expect(mockRedisSet).not.toHaveBeenCalled();
            expect(result).toBeNull();
        });
    });
});
