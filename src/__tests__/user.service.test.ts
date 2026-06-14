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
            secret: 'S_MOCK_SECRET_KEY'
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
            const createdUser = { id: '2', phoneNumber: '0987654321', stellarWallet: 'G_MOCK_PUBLIC_KEY:S_MOCK_SECRET_KEY' };
            prismaClientMock.user.create.mockResolvedValueOnce(createdUser);

            const result = await userService.getOrCreateUser('0987654321');

            expect(stellarServiceMock.generateWallet).toHaveBeenCalled();
            expect(stellarServiceMock.fundTestnetAccount).toHaveBeenCalledWith('G_MOCK_PUBLIC_KEY');
            expect(prismaClientMock.user.create).toHaveBeenCalledWith({
                data: {
                    phoneNumber: '0987654321',
                    stellarWallet: 'G_MOCK_PUBLIC_KEY:S_MOCK_SECRET_KEY'
                }
            });
            expect(result).toEqual(createdUser);
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
