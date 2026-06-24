import request from 'supertest';
import express from 'express';
import crypto from 'crypto';
import botRoutes from '../routes/bot.routes';
import { config } from '../config/env';

jest.mock('../queue/message.queue', () => ({
    enqueueMessage: jest.fn().mockResolvedValue({ id: 'mock-job-id' }),
}));

jest.mock('../middleware/rateLimiter', () => ({
    webhookRateLimiter: (req: any, res: any, next: any) => next(),
}));

jest.mock('../services/observability.service', () => ({
    observabilityService: { logInfo: jest.fn(), alertCriticalFailure: jest.fn() },
}));

const app = express();

app.use(express.json({
    verify: (req: any, res, buf) => {
        req.rawBody = buf;
    }
}));

app.use('/api', botRoutes);

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

    it('should reject requests without a signature', async () => {
        const payload = { object: 'whatsapp_business_account' };

        const response = await request(app)
            .post('/api/webhook')
            .send(payload);

        expect(response.status).toBe(401);
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

        expect(response.status).toBe(401);
        expect(response.body.error).toBe('Invalid signature');
    });

    it('should accept requests with a valid signature', async () => {
        const payload = {
            object: 'whatsapp_business_account',
            entry: [{
                changes: [{
                    value: {
                        messages: [{
                            from: '12345',
                            id: 'wamid.test',
                            text: { body: 'SEND 10 @jane' }
                        }]
                    }
                }]
            }]
        };
        const rawBodyString = JSON.stringify(payload);
        const validHash = crypto.createHmac('sha256', testSecret).update(rawBodyString, 'utf8').digest('hex');

        const response = await request(app)
            .post('/api/webhook')
            .set('x-hub-signature-256', `sha256=${validHash}`)
            .set('Content-Type', 'application/json')
            .send(rawBodyString);

        if (response.status !== 200) {
            console.log('Webhook integration failure response:', response.body);
        }
        expect(response.status).toBe(200);
    });
});
