import { startPaymentRequestWorker } from '../workers/payment-request.worker';
import { redisClient } from '../lib/redis';
import { PrismaClient } from '@prisma/client';
import { Job } from 'bullmq';

jest.mock('@prisma/client', () => {
    const mockPrisma = {
        user: {
            findUnique: jest.fn()
        }
    };
    return {
        PrismaClient: jest.fn(() => mockPrisma)
    };
});

jest.mock('../services/locale.service', () => ({
    t: (key: string, _lang: string, params?: Record<string, unknown>) =>
        `${key}|${JSON.stringify(params ?? {})}`,
}));

jest.mock('../services/whatsapp.service', () => {
    const sendMessage = jest.fn().mockResolvedValue(true);
    return {
        WhatsAppService: jest.fn().mockImplementation(() => ({ sendMessage })),
        __whatsappMocks: { sendMessage },
    };
});

jest.mock('../services/payment-request.service', () => {
    const sharedMocks = {
        completeRequest: jest.fn(),
        expireIfPending: jest.fn(),
    };
    return {
        PaymentRequestService: jest.fn().mockImplementation(() => sharedMocks),
        __sharedMocks: sharedMocks,
    };
});

const { __sharedMocks: paymentRequestMocks } = jest.requireMock('../services/payment-request.service');
const { __whatsappMocks } = jest.requireMock('../services/whatsapp.service');

jest.mock('bullmq', () => {
    let workerCallback: any;
    return {
        Worker: jest.fn().mockImplementation((name, cb) => {
            workerCallback = cb;
            return {
                on: jest.fn(),
                close: jest.fn().mockResolvedValue(true)
            };
        }),
        getWorkerCallback: () => workerCallback
    };
});

function makeJob(name: string, data: any): Job {
    return { name, data } as unknown as Job;
}

describe('Payment Request Worker', () => {
    let prisma: any;
    let workerCallback: any;
    let whatsapp: any;

    beforeAll(() => {
        Object.defineProperty(redisClient, 'status', { value: 'ready' });
        prisma = new PrismaClient();
    });

    beforeEach(() => {
        jest.clearAllMocks();
        startPaymentRequestWorker();
        const bullmq = require('bullmq');
        workerCallback = bullmq.getWorkerCallback();

        whatsapp = __whatsappMocks;
    });

    it('completes an accepted request and notifies both parties', async () => {
        (paymentRequestMocks.completeRequest as jest.Mock).mockResolvedValue({
            requesterId: 'u1',
            responderId: 'u2',
            amount: 50,
            assetCode: 'XLM',
            transactionHash: 'FINAL_HASH',
        });
        (prisma.user.findUnique as jest.Mock).mockImplementation(({ where }) =>
            Promise.resolve(
                where.id === 'u1'
                    ? { id: 'u1', phoneNumber: '1111', language: 'en' }
                    : { id: 'u2', phoneNumber: '2222', language: 'en' }
            )
        );

        await workerCallback(makeJob('complete-request', { requestId: 'pr-1' }));

        expect(paymentRequestMocks.completeRequest).toHaveBeenCalledWith('pr-1');
        const calls = whatsapp.sendMessage.mock.calls.map((c: any[]) => c[0]);
        expect(calls).toContain('1111');
        expect(calls).toContain('2222');
        // The requester message includes the explorer link with the tx hash
        expect(whatsapp.sendMessage.mock.calls.some(([, msg]: any[]) => String(msg).includes('FINAL_HASH'))).toBe(true);
    });

    it('skips completion when the request was not in ACCEPTED state', async () => {
        (paymentRequestMocks.completeRequest as jest.Mock).mockResolvedValue(null);

        await workerCallback(makeJob('complete-request', { requestId: 'pr-1' }));

        expect(whatsapp.sendMessage).not.toHaveBeenCalled();
    });

    it('expires a stale pending request and notifies the requester', async () => {
        (paymentRequestMocks.expireIfPending as jest.Mock).mockResolvedValue({
            requesterId: 'u1',
            responderId: 'u2',
            amount: 50,
            assetCode: 'XLM',
        });
        (prisma.user.findUnique as jest.Mock).mockImplementation(({ where }) =>
            Promise.resolve(
                where.id === 'u1'
                    ? { id: 'u1', phoneNumber: '1111', language: 'en', username: null }
                    : { id: 'u2', phoneNumber: '2222', language: 'en', username: 'jane' }
            )
        );

        await workerCallback(makeJob('expire-request', { requestId: 'pr-1' }));

        expect(paymentRequestMocks.expireIfPending).toHaveBeenCalledWith('pr-1');
        expect(whatsapp.sendMessage).toHaveBeenCalledTimes(1);
        expect(whatsapp.sendMessage.mock.calls[0][0]).toBe('1111');
    });

    it('does nothing on expiry when the request was already resolved', async () => {
        (paymentRequestMocks.expireIfPending as jest.Mock).mockResolvedValue(null);

        await workerCallback(makeJob('expire-request', { requestId: 'pr-1' }));

        expect(prisma.user.findUnique).not.toHaveBeenCalled();
        expect(whatsapp.sendMessage).not.toHaveBeenCalled();
    });
});
