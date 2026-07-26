import crypto from 'crypto';
import { webhookSignatureMiddleware, RequestWithRawBody } from '../middleware/webhook-signature.middleware';
import { config } from '../config/env';
import type { Response, NextFunction } from 'express';

jest.mock('../lib/redis', () => ({
    redisClient: {
        set: jest.fn(),
        get: jest.fn(),
    },
}));

jest.mock('../services/observability.service', () => ({
    observabilityService: {
        logInfo: jest.fn(),
        logError: jest.fn(),
        alertCriticalFailure: jest.fn(),
    },
}));

const { redisClient } = require('../lib/redis');
const mockRedisSet = redisClient.set as jest.Mock;
const { observabilityService } = require('../services/observability.service');
const mockLogError = observabilityService.logError as jest.Mock;

function buildValidSignature(rawBody: Buffer, secret: string): string {
    const hash = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    return `sha256=${hash}`;
}

function buildPayload(overrides?: { timestamp?: number; messageId?: string }) {
    const ts = overrides?.timestamp ?? Math.floor(Date.now() / 1000);
    const msgId = overrides?.messageId ?? 'wamid.test123';
    return {
        object: 'whatsapp_business_account',
        entry: [
            {
                changes: [
                    {
                        value: {
                            messages: [
                                {
                                    from: '12345',
                                    id: msgId,
                                    timestamp: String(ts),
                                    text: { body: 'Hello' },
                                },
                            ],
                        },
                    },
                ],
            },
        ],
    };
}

describe('webhookSignatureMiddleware', () => {
    const testSecret = 'test_secret_value';
    let originalSecret: string;
    let mockReq: Partial<RequestWithRawBody>;
    let mockRes: Partial<Response>;
    let mockNext: jest.Mock;

    beforeAll(() => {
        originalSecret = config.WHATSAPP_APP_SECRET;
        config.WHATSAPP_APP_SECRET = testSecret;
    });

    afterAll(() => {
        config.WHATSAPP_APP_SECRET = originalSecret;
    });

    beforeEach(() => {
        jest.clearAllMocks();
        mockReq = {
            headers: {},
            rawBody: undefined,
            body: {},
            ip: '127.0.0.1',
            socket: { remoteAddress: '127.0.0.1' } as any,
        };
        mockRes = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn(),
        };
        mockNext = jest.fn();
        mockRedisSet.mockResolvedValue('OK');
    });

    describe('signature verification', () => {
        it('should call next() if the signature is valid and webhook is not stale or duplicate', async () => {
            const payload = buildPayload();
            const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
            mockReq.headers = { 'x-hub-signature-256': buildValidSignature(rawBody, testSecret) };
            mockReq.rawBody = rawBody;
            mockReq.body = payload;

            await webhookSignatureMiddleware(
                mockReq as RequestWithRawBody,
                mockRes as Response,
                mockNext,
            );

            expect(mockNext).toHaveBeenCalledTimes(1);
            expect(mockRes.status).not.toHaveBeenCalled();
            expect(mockRes.json).not.toHaveBeenCalled();
        });

        it('should return 403 if the signature header is missing', async () => {
            mockReq.rawBody = Buffer.from('test', 'utf8');

            await webhookSignatureMiddleware(
                mockReq as RequestWithRawBody,
                mockRes as Response,
                mockNext,
            );

            expect(mockRes.status).toHaveBeenCalledWith(403);
            expect(mockRes.json).toHaveBeenCalledWith({ error: 'Missing signature' });
            expect(mockNext).not.toHaveBeenCalled();
        });

        it('should return 500 if the rawBody is missing', async () => {
            mockReq.headers = { 'x-hub-signature-256': 'sha256=somehash' };

            await webhookSignatureMiddleware(
                mockReq as RequestWithRawBody,
                mockRes as Response,
                mockNext,
            );

            expect(mockRes.status).toHaveBeenCalledWith(500);
            expect(mockRes.json).toHaveBeenCalledWith({ error: 'Raw body missing' });
            expect(mockNext).not.toHaveBeenCalled();
        });

        it('should return 403 if the body has been tampered with', async () => {
            const originalPayload = { test: 'data' };
            const rawBody = Buffer.from(JSON.stringify(originalPayload), 'utf8');
            const tamperedBody = Buffer.from(JSON.stringify({ test: 'tampered' }), 'utf8');
            const signature = buildValidSignature(tamperedBody, testSecret);

            mockReq.headers = { 'x-hub-signature-256': signature };
            mockReq.rawBody = rawBody;

            await webhookSignatureMiddleware(
                mockReq as RequestWithRawBody,
                mockRes as Response,
                mockNext,
            );

            expect(mockRes.status).toHaveBeenCalledWith(403);
            expect(mockRes.json).toHaveBeenCalledWith({ error: 'Invalid signature' });
            expect(mockNext).not.toHaveBeenCalled();
        });

        it('should return 403 if the signature length does not match', async () => {
            mockReq.headers = { 'x-hub-signature-256': 'sha256=tooshort' };
            mockReq.rawBody = Buffer.from('test', 'utf8');

            await webhookSignatureMiddleware(
                mockReq as RequestWithRawBody,
                mockRes as Response,
                mockNext,
            );

            expect(mockRes.status).toHaveBeenCalledWith(403);
            expect(mockRes.json).toHaveBeenCalledWith({ error: 'Invalid signature' });
            expect(mockNext).not.toHaveBeenCalled();
        });

        it('should use timingSafeEqual for signature comparison', async () => {
            const spy = jest.spyOn(crypto, 'timingSafeEqual');
            const payload = buildPayload();
            const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
            mockReq.headers = { 'x-hub-signature-256': buildValidSignature(rawBody, testSecret) };
            mockReq.rawBody = rawBody;
            mockReq.body = payload;

            await webhookSignatureMiddleware(
                mockReq as RequestWithRawBody,
                mockRes as Response,
                mockNext,
            );

            expect(spy).toHaveBeenCalled();
            spy.mockRestore();
        });
    });

    describe('stale webhook detection', () => {
        it('should reject a webhook with a timestamp older than 5 minutes', async () => {
            const staleTimestamp = Math.floor(Date.now() / 1000) - 301;
            const payload = buildPayload({ timestamp: staleTimestamp });
            const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
            mockReq.headers = { 'x-hub-signature-256': buildValidSignature(rawBody, testSecret) };
            mockReq.rawBody = rawBody;
            mockReq.body = payload;

            await webhookSignatureMiddleware(
                mockReq as RequestWithRawBody,
                mockRes as Response,
                mockNext,
            );

            expect(mockRes.status).toHaveBeenCalledWith(403);
            expect(mockRes.json).toHaveBeenCalledWith({ error: 'Stale webhook' });
            expect(mockNext).not.toHaveBeenCalled();
        });

        it('should accept a webhook with a timestamp within 5 minutes', async () => {
            const freshTimestamp = Math.floor(Date.now() / 1000) - 299;
            const payload = buildPayload({ timestamp: freshTimestamp });
            const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
            mockReq.headers = { 'x-hub-signature-256': buildValidSignature(rawBody, testSecret) };
            mockReq.rawBody = rawBody;
            mockReq.body = payload;

            await webhookSignatureMiddleware(
                mockReq as RequestWithRawBody,
                mockRes as Response,
                mockNext,
            );

            expect(mockRes.status).not.toHaveBeenCalled();
            expect(mockNext).toHaveBeenCalledTimes(1);
        });
    });

    describe('replay attack prevention', () => {
        it('should reject a duplicate message ID via Redis NX', async () => {
            const payload = buildPayload({ messageId: 'wamid.replay' });
            const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
            mockReq.headers = { 'x-hub-signature-256': buildValidSignature(rawBody, testSecret) };
            mockReq.rawBody = rawBody;
            mockReq.body = payload;

            mockRedisSet.mockResolvedValue(null);

            await webhookSignatureMiddleware(
                mockReq as RequestWithRawBody,
                mockRes as Response,
                mockNext,
            );

            expect(mockRedisSet).toHaveBeenCalledWith(
                'webhook:id:wamid.replay',
                '1',
                'EX',
                600,
                'NX',
            );
            expect(mockRes.status).toHaveBeenCalledWith(403);
            expect(mockRes.json).toHaveBeenCalledWith({ error: 'Duplicate webhook' });
            expect(mockNext).not.toHaveBeenCalled();
        });

        it('should allow a new message ID (Redis NX returns OK)', async () => {
            const payload = buildPayload({ messageId: 'wamid.newmsg' });
            const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
            mockReq.headers = { 'x-hub-signature-256': buildValidSignature(rawBody, testSecret) };
            mockReq.rawBody = rawBody;
            mockReq.body = payload;

            await webhookSignatureMiddleware(
                mockReq as RequestWithRawBody,
                mockRes as Response,
                mockNext,
            );

            expect(mockRedisSet).toHaveBeenCalledWith(
                'webhook:id:wamid.newmsg',
                '1',
                'EX',
                600,
                'NX',
            );
            expect(mockNext).toHaveBeenCalledTimes(1);
        });
    });

    describe('graceful degradation when Redis is unavailable', () => {
        it('should log a warning and continue when Redis set fails', async () => {
            const payload = buildPayload();
            const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
            mockReq.headers = { 'x-hub-signature-256': buildValidSignature(rawBody, testSecret) };
            mockReq.rawBody = rawBody;
            mockReq.body = payload;

            mockRedisSet.mockRejectedValue(new Error('Redis connection refused'));

            await webhookSignatureMiddleware(
                mockReq as RequestWithRawBody,
                mockRes as Response,
                mockNext,
            );

            expect(mockLogError).toHaveBeenCalledWith(
                'Redis unavailable for replay checking, proceeding without replay protection',
                expect.any(Error),
                expect.objectContaining({ ip: '127.0.0.1' }),
            );
            expect(mockNext).toHaveBeenCalledTimes(1);
        });
    });

    describe('logging on rejection', () => {
        it('should log when signature is missing', async () => {
            mockReq.rawBody = Buffer.from('test', 'utf8');

            await webhookSignatureMiddleware(
                mockReq as RequestWithRawBody,
                mockRes as Response,
                mockNext,
            );

            expect(mockLogError).toHaveBeenCalledWith(
                'Webhook signature verification failed',
                undefined,
                expect.objectContaining({
                    ip: '127.0.0.1',
                    signature: null,
                    reason: 'missing signature header',
                }),
            );
        });

        it('should log when signature is invalid with a truncated signature', async () => {
            const longSig = 'sha256=' + 'a'.repeat(64);
            mockReq.headers = { 'x-hub-signature-256': longSig };
            mockReq.rawBody = Buffer.from('test', 'utf8');

            await webhookSignatureMiddleware(
                mockReq as RequestWithRawBody,
                mockRes as Response,
                mockNext,
            );

            expect(mockLogError).toHaveBeenCalledWith(
                'Webhook signature verification failed',
                undefined,
                expect.objectContaining({
                    ip: '127.0.0.1',
                    signature: 'sha256=a...aaaa',
                    reason: 'invalid signature',
                }),
            );
        });
    });

    describe('payloads without messages', () => {
        it('should pass through for status updates without a message', async () => {
            const payload = {
                object: 'whatsapp_business_account',
                entry: [
                    {
                        changes: [
                            {
                                value: {
                                    statuses: [{ id: 'status123', status: 'read', timestamp: String(Math.floor(Date.now() / 1000)) }],
                                },
                            },
                        ],
                    },
                ],
            };
            const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
            mockReq.headers = { 'x-hub-signature-256': buildValidSignature(rawBody, testSecret) };
            mockReq.rawBody = rawBody;
            mockReq.body = payload;

            await webhookSignatureMiddleware(
                mockReq as RequestWithRawBody,
                mockRes as Response,
                mockNext,
            );

            expect(mockRes.status).not.toHaveBeenCalled();
            expect(mockNext).toHaveBeenCalledTimes(1);
        });

        it('should pass through for empty body with no entry', async () => {
            const payload = { object: 'whatsapp_business_account' };
            const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
            mockReq.headers = { 'x-hub-signature-256': buildValidSignature(rawBody, testSecret) };
            mockReq.rawBody = rawBody;
            mockReq.body = payload;

            await webhookSignatureMiddleware(
                mockReq as RequestWithRawBody,
                mockRes as Response,
                mockNext,
            );

            expect(mockRes.status).not.toHaveBeenCalled();
            expect(mockNext).toHaveBeenCalledTimes(1);
        });
    });
});
