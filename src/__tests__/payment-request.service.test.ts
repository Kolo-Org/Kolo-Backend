import { PaymentRequestService, PaymentRequestError } from '../services/payment-request.service';
import { decrypt } from '../utils/encryption.util';

jest.mock('../lib/prisma', () => ({
    prisma: {
        paymentRequest: {
            create: jest.fn(),
            findUnique: jest.fn(),
            update: jest.fn(),
            updateMany: jest.fn(),
            count: jest.fn(),
        },
        user: {
            findUnique: jest.fn(),
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
        mockDecrypt.mockReturnValue(Buffer.from('responder-seed'));
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
            (prisma.paymentRequest.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
            (prisma.paymentRequest.update as jest.Mock).mockResolvedValue({ ...request, status: 'ACCEPTED', balanceId: 'CB-123' });

            const result = await service.acceptRequest('pr-1', '2222');

            // Balance was checked before locking funds
            expect(mockStellar.checkBalance).toHaveBeenCalledWith('G_RESP');
            // The PENDING → HOLDING transition happened before any Stellar call
            expect(prisma.paymentRequest.updateMany).toHaveBeenCalledWith({
                where: { id: 'pr-1', status: 'PENDING' },
                data: { status: 'HOLDING' },
            });
            expect(mockDecrypt).toHaveBeenCalledWith('ENC', 'IV', 'TAG');
            expect(mockStellar.createClaimableBalanceWithHold).toHaveBeenCalledWith(
                Buffer.from('responder-seed'),
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

        it('releases the hold claim when placing the escrow fails', async () => {
            const request = makeRequest();
            (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(request);
            (prisma.paymentRequest.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
            mockStellar.createClaimableBalanceWithHold.mockRejectedValue(new Error('horizon down'));

            await expect(service.acceptRequest('pr-1', '2222')).rejects.toThrow('horizon down');

            expect(prisma.paymentRequest.updateMany).toHaveBeenCalledWith({
                where: { id: 'pr-1', status: 'HOLDING' },
                data: { status: 'PENDING' },
            });
        });

        it('refuses a second accept once another one claimed the transition', async () => {
            const request = makeRequest();
            (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(request);
            (prisma.paymentRequest.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

            await expect(service.acceptRequest('pr-1', '2222')).rejects.toMatchObject({ code: 'not_pending' });
            expect(mockStellar.createClaimableBalanceWithHold).not.toHaveBeenCalled();
        });

        it('never returns to PENDING when the hold succeeded but recording failed', async () => {
            const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
            const request = makeRequest();
            (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(request);
            (prisma.paymentRequest.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
            // Every attempt to record the ACCEPTED state fails.
            (prisma.paymentRequest.update as jest.Mock).mockRejectedValue(new Error('db down'));

            await expect(service.acceptRequest('pr-1', '2222')).rejects.toThrow('db down');

            // The escrow is funded on-chain, so the request must NOT be
            // released back to PENDING — that would allow a second hold.
            expect(prisma.paymentRequest.updateMany).not.toHaveBeenCalledWith({
                where: { id: 'pr-1', status: 'HOLDING' },
                data: { status: 'PENDING' },
            });
            // The recording write was retried before giving up.
            expect(prisma.paymentRequest.update).toHaveBeenCalledTimes(3);
            expect(consoleError).toHaveBeenCalledWith(
                expect.stringContaining('CRITICAL'),
                expect.anything(),
            );
            consoleError.mockRestore();
        }, 15000);

        it('releases the claim back to PENDING only when the Stellar call itself fails', async () => {
            const request = makeRequest();
            (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(request);
            (prisma.paymentRequest.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
            mockStellar.createClaimableBalanceWithHold.mockRejectedValue(new Error('horizon down'));

            await expect(service.acceptRequest('pr-1', '2222')).rejects.toThrow('horizon down');

            expect(prisma.paymentRequest.updateMany).toHaveBeenCalledWith({
                where: { id: 'pr-1', status: 'HOLDING' },
                data: { status: 'PENDING' },
            });
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
            (prisma.paymentRequest.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

            await service.declineRequest('pr-1', '2222');

            expect(prisma.paymentRequest.updateMany).toHaveBeenCalledWith({
                where: { id: 'pr-1', status: 'PENDING' },
                data: { status: 'DECLINED' },
            });
        });

        it('prevents declining someone else\'s request', async () => {
            (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(makeRequest());

            await expect(service.declineRequest('pr-1', 'wrong-user')).rejects.toMatchObject({ code: 'not_responder' });
        });
    });

    describe('completeRequest', () => {
        it('claims the held balance for the requester and records the hash', async () => {
            (prisma.paymentRequest.findUnique as jest.Mock)
                .mockResolvedValueOnce(makeRequest({ status: 'ACCEPTED', balanceId: 'CB-123' }))
                .mockResolvedValueOnce(makeRequest({ status: 'COMPLETED', transactionHash: 'CLAIM_HASH' }));
            (prisma.paymentRequest.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
            (prisma.user.findUnique as jest.Mock).mockResolvedValue({ stellarWallet: REQUESTER_WALLET });
            (prisma.paymentRequest.update as jest.Mock).mockResolvedValue({
                status: 'COMPLETED', transactionHash: 'CLAIM_HASH',
            });

            const result = await service.completeRequest('pr-1');

            // ACCEPTED → COMPLETING claimed atomically before the Stellar call
            expect(prisma.paymentRequest.updateMany).toHaveBeenCalledWith({
                where: { id: 'pr-1', status: 'ACCEPTED' },
                data: { status: 'COMPLETING' },
            });
            // The requester's own secret claims the balance
            expect(mockDecrypt).toHaveBeenCalledWith('ENC2', 'IV2', 'TAG2');
            expect(mockDecrypt).toHaveBeenCalledTimes(1);
            expect(mockStellar.claimClaimableBalance).toHaveBeenCalledWith(Buffer.from('responder-seed'), 'CB-123');
            expect(result.status).toBe('COMPLETED');
        });

        it('does nothing when the request is not in ACCEPTED state', async () => {
            (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(makeRequest());
            (prisma.paymentRequest.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

            const result = await service.completeRequest('pr-1');

            expect(result).toBeNull();
            expect(mockStellar.claimClaimableBalance).not.toHaveBeenCalled();
        });

        it('reverts to ACCEPTED when the claim fails, so jobs can retry', async () => {
            (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(
                makeRequest({ status: 'ACCEPTED', balanceId: 'CB-123' })
            );
            (prisma.paymentRequest.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
            (prisma.user.findUnique as jest.Mock).mockResolvedValue({ stellarWallet: REQUESTER_WALLET });
            mockStellar.claimClaimableBalance.mockRejectedValue(new Error('network'));

            await expect(service.completeRequest('pr-1')).rejects.toThrow('network');

            expect(prisma.paymentRequest.updateMany).toHaveBeenCalledWith({
                where: { id: 'pr-1', status: 'COMPLETING' },
                data: { status: 'ACCEPTED' },
            });
        });
    });

    describe('expireIfPending', () => {
        it('expires a stale pending request', async () => {
            (prisma.paymentRequest.updateMany as jest.Mock).mockResolvedValue({ count: 1 });
            (prisma.paymentRequest.findUnique as jest.Mock).mockResolvedValue(makeRequest({ status: 'EXPIRED' }));

            const result = await service.expireIfPending('pr-1');

            expect(prisma.paymentRequest.updateMany).toHaveBeenCalledWith({
                where: { id: 'pr-1', status: 'PENDING' },
                data: { status: 'EXPIRED' },
            });
            expect(result.status).toBe('EXPIRED');
        });

        it('leaves accepted requests alone (funds already in escrow)', async () => {
            (prisma.paymentRequest.updateMany as jest.Mock).mockResolvedValue({ count: 0 });

            const result = await service.expireIfPending('pr-1');

            expect(result).toBeNull();
        });
    });
});
