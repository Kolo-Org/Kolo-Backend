import { PaymentRequestService, PaymentRequestError } from '../services/payment-request.service';
import { decrypt } from '../utils/encryption.util';

jest.mock('../lib/prisma', () => ({
    prisma: {
        paymentRequest: {
            create: jest.fn(),
            findUnique: jest.fn(),
            update: jest.fn(),
            count: jest.fn(),
        },
    },
}));

jest.mock('../utils/encryption.util', () => ({
    decrypt: jest.fn().mockReturnValue('S_RESPONDER_SECRET'),
    encrypt: jest.fn(),
}));

const { prisma } = require('../lib/prisma');
const mockDecrypt = decrypt as jest.Mock;

const WALLET = JSON.stringify({ publicKey: 'G_RESP', encryptedSecret: 'ENC', iv: 'IV', authTag: 'TAG' });
const REQUESTER_WALLET = JSON.stringify({ publicKey: 'G_REQ', encryptedSecret: 'ENC2', iv: 'IV2', authTag: 'TAG2' });

function makeRequest(overrides: Record<string, any> = {}) {
    return {
        id: 'pr-1',
        requesterId: 'u1',
        responderId: 'u2',
        amount: '50',
        assetCode: 'XLM',
        status: 'PENDING',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        balanceId: null,
        transactionHash: null,
        requester: { id: 'u1', phoneNumber: '1111', language: 'en', stellarWallet: REQUESTER_WALLET },
        responder: { id: 'u2', phoneNumber: '2222', language: 'en', stellarWallet: WALLET },
        ...overrides,
    };
}

describe('PaymentRequestService', () => {
    let service: PaymentRequestService;
    let mockStellar: {
        createClaimableBalanceWithHold: jest.Mock;
        claimClaimableBalance: jest.Mock;
        checkBalance: jest.Mock;
    };

    beforeEach(() => {
        jest.clearAllMocks();
        mockDecrypt.mockReturnValue('S_RESPONDER_SECRET');
        mockStellar = {
            createClaimableBalanceWithHold: jest.fn().mockResolvedValue({ hash: 'HOLD_HASH', balanceId: 'CB-123' }),
            claimClaimableBalance: jest.fn().mockResolvedValue({ hash: 'CLAIM_HASH' }),
            checkBalance: jest.fn().mockResolvedValue([{ assetCode: 'XLM', issuer: '', balance: '100.00' }]),
        };
        service = new PaymentRequestService(mockStellar as any);
    });

    describe('createRequest', () => {
        it('creates a PENDING request expiring in 24 hours', async () => {
            (prisma.paymentRequest.count as jest.Mock).mockResolvedValue(0);
            (prisma.paymentRequest.create as jest.Mock).mockImplementation(({ data }) =>
                Promise.resolve({ id: 'new-req', ...data }));

            const result = await service.createRequest('u1', 'u2', '50');

            expect(prisma.paymentRequest.create).toHaveBeenCalledWith(expect.objectContaining({
                data: expect.objectContaining({
                    requesterId: 'u1',
                    responderId: 'u2',
                    amount: '50',
                    status: 'PENDING',
                }),
            }));
            const expectedExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
            expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(expectedExpiry.getTime() - 1000);
        });

        it('rejects when the requester already has 5 pending requests', async () => {
            (prisma.paymentRequest.count as jest.Mock).mockResolvedValue(5);

            await expect(service.createRequest('u1', 'u2', '50')).rejects.toThrow(PaymentRequestError);
            expect(prisma.paymentRequest.create).not.toHaveBeenCalled();
        });
    });

    describe('acceptRequest', () => {
        it('verifies balance, places the escrow hold and stores the balance ID', async () => {
            const request = makeRequest();
            (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(request);
            (prisma.paymentRequest.update as jest.Mock).mockResolvedValue({ ...request, status: 'ACCEPTED', balanceId: 'CB-123' });

            const result = await service.acceptRequest('pr-1', '2222');

            // Balance was checked before locking funds
            expect(mockStellar.checkBalance).toHaveBeenCalledWith('G_RESP');
            // Hold created from the respondent's wallet for the requester
            expect(mockDecrypt).toHaveBeenCalledWith('ENC', 'IV', 'TAG');
            expect(mockStellar.createClaimableBalanceWithHold).toHaveBeenCalledWith(
                'S_RESPONDER_SECRET',
                'G_REQ',
                '50',
                3600,
            );
            expect(prisma.paymentRequest.update).toHaveBeenCalledWith(expect.objectContaining({
                where: { id: 'pr-1' },
                data: expect.objectContaining({ status: 'ACCEPTED', balanceId: 'CB-123' }),
            }));
            expect(result.hash).toBe('HOLD_HASH');
        });

        it('rejects acceptance by anyone who is not the responder', async () => {
            (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(makeRequest());

            await expect(service.acceptRequest('pr-1', '9999')).rejects.toMatchObject({ code: 'not_responder' });
            expect(mockStellar.createClaimableBalanceWithHold).not.toHaveBeenCalled();
        });

        it('rejects an expired request', async () => {
            (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(
                makeRequest({ expiresAt: new Date(Date.now() - 1000) })
            );

            await expect(service.acceptRequest('pr-1', '2222')).rejects.toMatchObject({ code: 'expired' });
        });

        it('rejects a request that is no longer pending', async () => {
            (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(makeRequest({ status: 'DECLINED' }));

            await expect(service.acceptRequest('pr-1', '2222')).rejects.toMatchObject({ code: 'not_pending' });
        });

        it('rejects when the responder cannot cover the amount', async () => {
            (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(makeRequest());
            mockStellar.checkBalance.mockResolvedValue([{ assetCode: 'XLM', issuer: '', balance: '5.00' }]);

            await expect(service.acceptRequest('pr-1', '2222')).rejects.toMatchObject({ code: 'insufficient_balance' });
            expect(mockStellar.createClaimableBalanceWithHold).not.toHaveBeenCalled();
        });

        it('rejects a request that does not exist', async () => {
            (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(null);

            await expect(service.acceptRequest('missing', '2222')).rejects.toMatchObject({ code: 'not_found' });
        });
    });

    describe('declineRequest', () => {
        it('marks the request declined for the correct responder', async () => {
            const request = makeRequest();
            (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(request);
            (prisma.paymentRequest.update as jest.Mock).mockResolvedValue({ ...request, status: 'DECLINED' });

            await service.declineRequest('pr-1', '2222');

            expect(prisma.paymentRequest.update).toHaveBeenCalledWith(expect.objectContaining({
                where: { id: 'pr-1' },
                data: { status: 'DECLINED' },
            }));
        });

        it('prevents declining someone else\'s request', async () => {
            (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(makeRequest());

            await expect(service.declineRequest('pr-1', 'wrong-user')).rejects.toMatchObject({ code: 'not_responder' });
        });
    });

    describe('completeRequest', () => {
        it('claims the held balance for the requester and records the hash', async () => {
            (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(
                makeRequest({ status: 'ACCEPTED', balanceId: 'CB-123' })
            );
            (prisma.paymentRequest.update as jest.Mock).mockResolvedValue({
                status: 'COMPLETED', transactionHash: 'CLAIM_HASH',
            });

            const result = await service.completeRequest('pr-1');

            expect(mockStellar.claimClaimableBalance).toHaveBeenCalledWith('S_RESPONDER_SECRET', 'CB-123');
            // The requester's own secret claims the balance
            expect(mockDecrypt).toHaveBeenCalledWith('ENC2', 'IV2', 'TAG2');
            expect(prisma.paymentRequest.update).toHaveBeenCalledWith(expect.objectContaining({
                data: { status: 'COMPLETED', transactionHash: 'CLAIM_HASH' },
            }));
            expect(result.status).toBe('COMPLETED');
        });

        it('does nothing when the request is not in ACCEPTED state', async () => {
            (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(makeRequest());

            const result = await service.completeRequest('pr-1');

            expect(result).toBeNull();
            expect(mockStellar.claimClaimableBalance).not.toHaveBeenCalled();
        });
    });

    describe('expireIfPending', () => {
        it('expires a stale pending request', async () => {
            (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(makeRequest());
            (prisma.paymentRequest.update as jest.Mock).mockResolvedValue({ status: 'EXPIRED' });

            const result = await service.expireIfPending('pr-1');

            expect(prisma.paymentRequest.update).toHaveBeenCalledWith(expect.objectContaining({
                data: { status: 'EXPIRED' },
            }));
            expect(result.status).toBe('EXPIRED');
        });

        it('leaves accepted requests alone (funds already in escrow)', async () => {
            (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(makeRequest({ status: 'ACCEPTED' }));

            const result = await service.expireIfPending('pr-1');

            expect(result).toBeNull();
            expect(prisma.paymentRequest.update).not.toHaveBeenCalled();
        });
    });
});
