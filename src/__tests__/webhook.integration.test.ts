import request from 'supertest';
import express from 'express';
import crypto from 'crypto';
import { config } from '../config/env';

jest.mock('../lib/redis', () => ({
    redisClient: {
        set: jest.fn(),
        get: jest.fn(),
    },
}));

jest.mock('../queue/message.queue', () => ({
    enqueueMessage: jest.fn().mockResolvedValue({ id: 'mock-job-id' }),
}));

jest.mock('../middleware/rateLimiter', () => ({
    webhookRateLimiter: (req: any, res: any, next: any) => next(),
}));

jest.mock('../services/observability.service', () => ({
    observabilityService: { logInfo: jest.fn(), logError: jest.fn(), alertCriticalFailure: jest.fn() },
}));

const { redisClient } = require('../lib/redis');
const mockRedisSet = redisClient.set as jest.Mock;

import botRoutes from '../routes/bot.routes';

const app = express();

app.use(express.json({
    verify: (req: any, res, buf) => {
        req.rawBody = buf;
    },
}));

app.use('/api', botRoutes);

function validPayload(overrides?: { timestamp?: number; messageId?: string }) {
    const ts = overrides?.timestamp ?? Math.floor(Date.now() / 1000);
    const msgId = overrides?.messageId ?? 'wamid.integration.test';
    return {
        object: 'whatsapp_business_account',
        entry: [{
            id: 'phone_number_id',
            changes: [{
                value: {
                    messaging_product: 'whatsapp',
                    metadata: { display_phone_number: '15551234567', phone_number_id: '123456' },
                    contacts: [{ profile: { name: 'Test User' }, wa_id: '12345' }],
                    messages: [{
                        from: '12345',
                        id: msgId,
                        timestamp: String(ts),
                        text: { body: 'SEND 10 @jane' },
                    }],
                },
            }],
        }],
    };
}

function sign(payload: object, secret: string): string {
    const rawBodyString = JSON.stringify(payload);
    const hash = crypto.createHmac('sha256', secret).update(rawBodyString, 'utf8').digest('hex');
    return `sha256=${hash}`;
}

describe('Webhook Integration', () => {
    const testSecret = 'integration_secret';
    let originalSecret: string;

    beforeAll(() => {
        originalSecret = config.WHATSAPP_APP_SECRET;
        config.WHATSAPP_APP_SECRET = testSecret;
    });

    afterAll(() => {
        config.WHATSAPP_APP_SECRET = originalSecret;
    });

    beforeEach(() => {
        jest.clearAllMocks();
        mockRedisSet.mockResolvedValue('OK');
    });

    it('should reject requests without a signature', async () => {
        const payload = { object: 'whatsapp_business_account' };

        const response = await request(app)
            .post('/api/webhook')
            .send(payload);

        expect(response.status).toBe(403);
        expect(response.body.error).toBe('Missing signature');
    });

    it('should reject requests with an invalid signature', async () => {
        const payload = { object: 'whatsapp_business_account' };
        const rawBodyString = JSON.stringify(payload);
        const wrongHash = crypto.createHmac('sha256', 'wrong_secret').update(rawBodyString, 'utf8').digest('hex');

        const response = await request(app)
            .post('/api/webhook')
            .set('x-hub-signature-256', `sha256=${wrongHash}`)
            .set('Content-Type', 'application/json')
            .send(rawBodyString);

        expect(response.status).toBe(403);
        expect(response.body.error).toBe('Invalid signature');
    });

    it('should accept requests with a valid signature', async () => {
        const payload = validPayload();
        const signature = sign(payload, testSecret);

        const response = await request(app)
            .post('/api/webhook')
            .set('x-hub-signature-256', signature)
            .set('Content-Type', 'application/json')
            .send(JSON.stringify(payload));

        if (response.status !== 200) {
            console.log('Webhook integration failure response:', response.body);
        }
        expect(response.status).toBe(200);
    });

    it('should reject a forged signature', async () => {
        const payload = validPayload();

        const response = await request(app)
            .post('/api/webhook')
            .set('x-hub-signature-256', 'sha256=0000000000000000000000000000000000000000000000000000000000000000')
            .set('Content-Type', 'application/json')
            .send(JSON.stringify(payload));

        expect(response.status).toBe(403);
        expect(response.body.error).toBe('Invalid signature');
    });

    it('should reject a stale webhook with timestamp older than 5 minutes', async () => {
        const staleTimestamp = Math.floor(Date.now() / 1000) - 301;
        const payload = validPayload({ timestamp: staleTimestamp });
        const signature = sign(payload, testSecret);

        const response = await request(app)
            .post('/api/webhook')
            .set('x-hub-signature-256', signature)
            .set('Content-Type', 'application/json')
            .send(JSON.stringify(payload));

        expect(response.status).toBe(403);
        expect(response.body.error).toBe('Stale webhook');
    });

    it('should reject a duplicate webhook (replay attack)', async () => {
        mockRedisSet.mockResolvedValue(null);

        const payload = validPayload({ messageId: 'wamid.replay.test' });
        const signature = sign(payload, testSecret);

        const response = await request(app)
            .post('/api/webhook')
            .set('x-hub-signature-256', signature)
            .set('Content-Type', 'application/json')
            .send(JSON.stringify(payload));

        expect(response.status).toBe(403);
        expect(response.body.error).toBe('Duplicate webhook');
    });
});
