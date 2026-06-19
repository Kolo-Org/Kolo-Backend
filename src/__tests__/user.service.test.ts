import { UserService } from '../services/user.service';
import { PrismaClient } from '@prisma/client';
import { StellarService } from '../services/stellar.service';

// Mock the modules
jest.mock('@prisma/client', () => {
    const mPrismaClient = {
        user: {
            findUnique: jest.fn(),
            create: jest.fn(),
        },
    };
    return { PrismaClient: jest.fn(() => mPrismaClient) };
});

jest.mock('../services/stellar.service', () => {
    const mStellarService = {
        generateWallet: jest.fn(() => ({
            publicKey: 'G_MOCK_PUBLIC_KEY',
            encryptedSecret: 'ENC_SECRET',
            iv: 'IV',
            authTag: 'TAG'
        })),
        fundTestnetAccount: jest.fn().mockResolvedValue(true)
    };
    return { StellarService: jest.fn(() => mStellarService) };
});

describe('UserService', () => {
    let userService: UserService;
    let prismaClientMock: any;
    let stellarServiceMock: any;

    beforeEach(() => {
        jest.clearAllMocks();
        userService = new UserService();
        prismaClientMock = new PrismaClient();
        stellarServiceMock = new StellarService();
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
                    stellarWallet: expectedWallet,
                    language: 'en'
                }
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
});
