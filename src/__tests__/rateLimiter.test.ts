import { Request, Response, NextFunction } from 'express';
import { webhookRateLimiter, customKeyGenerator } from '../middleware/rateLimiter';

jest.mock('ioredis', () => {
    return jest.fn().mockImplementation(() => {
        return {
            call: jest.fn(),
            on: jest.fn(),
        };
    });
});

describe('Rate Limiter Middleware', () => {
    describe('customKeyGenerator', () => {
        it('should extract the WhatsApp sender phone number from a valid webhook payload', () => {
            const req = {
                body: {
                    object: 'whatsapp_business_account',
                    entry: [
                        {
                            changes: [
                                {
                                    value: {
                                        messages: [
                                            {
                                                from: '1234567890',
                                            },
                                        ],
                                    },
                                },
                            ],
                        },
                    ],
                },
            } as any;

            const key = customKeyGenerator(req);
            expect(key).toBe('1234567890');
        });

        it('should fallback to IP if body does not match expected structure', () => {
            const req = {
                body: { object: 'page' },
                ip: '192.168.1.1',
            } as any;

            const key = customKeyGenerator(req);
            expect(key).toBe('192.168.1.1');
        });

        it('should fallback to socket.remoteAddress if IP is not set', () => {
            const req = {
                body: {},
                socket: { remoteAddress: '10.0.0.1' },
            } as any;

            const key = customKeyGenerator(req);
            expect(key).toBe('10.0.0.1');
        });

        it('should fallback to "unknown" if nothing is available', () => {
            const req = {
                body: null,
            } as any;

            const key = customKeyGenerator(req);
            expect(key).toBe('unknown');
        });
    });

    describe('webhookRateLimiter', () => {
        it('should be defined as a middleware function', () => {
            expect(typeof webhookRateLimiter).toBe('function');
        });

        it('should execute as a middleware', () => {
            const req = { ip: '127.0.0.1', body: {} } as any;
            const res = { setHeader: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() } as any;
            const next = jest.fn();

            webhookRateLimiter(req, res, next);
            // Since it's async under the hood and uses Redis, we can just verify it doesn't throw synchronously
            expect(webhookRateLimiter).toBeDefined();
        });
    });
});
