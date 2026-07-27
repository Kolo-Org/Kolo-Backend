import { Request, Response, NextFunction } from 'express';
import {
    commandRateLimitMiddleware,
    setForceRedisFailure,
    clearInMemoryStore,
    classifyCommand,
    extractMessageDetails,
} from '../middleware/command-rate-limit.middleware';
import { abuseDetectionService } from '../services/abuse-detection.service';
import { redisClient } from '../lib/redis';
import { prisma } from '../lib/prisma';
import { WhatsAppService } from '../services/whatsapp.service';

// Mock Redis client
jest.mock('../lib/redis', () => {
    return {
        redisClient: {
            status: 'ready',
            eval: jest.fn(),
            lpush: jest.fn(),
            ltrim: jest.fn(),
            lrange: jest.fn().mockResolvedValue([]),
            zadd: jest.fn(),
            zremrangebyscore: jest.fn(),
            zcard: jest.fn(),
            expire: jest.fn(),
            exists: jest.fn().mockResolvedValue(0),
            set: jest.fn(),
        },
    };
});

// Mock Prisma
jest.mock('../lib/prisma', () => ({
    prisma: {
        user: {
            findUnique: jest.fn(),
        },
    },
}));

// Mock WhatsAppService
jest.mock('../services/whatsapp.service', () => {
    const mockSend = jest.fn().mockResolvedValue(true);
    return {
        WhatsAppService: jest.fn().mockImplementation(() => {
            return {
                sendMessage: mockSend,
            };
        }),
    };
});

// Mock locale service
jest.mock('../services/locale.service', () => ({
    initI18n: jest.fn().mockResolvedValue(undefined),
    t: jest.fn((key, lang, params) => `⚠️ You're sending too many requests. Please wait ${params?.remainingSeconds} seconds.`),
}));

describe('Sliding Window Rate Limiter & Abuse Detection', () => {
    let req: any;
    let res: any;
    let next: jest.Mock;
    let mockWhatsAppServiceInstance: any;

    beforeEach(() => {
        jest.clearAllMocks();
        clearInMemoryStore();
        abuseDetectionService.clearInMemory();
        setForceRedisFailure(false);
        abuseDetectionService.setForceRedisFailure(false);

        // Reset Redis client mock implementations
        (redisClient.status as any) = 'ready';
        (redisClient.eval as jest.Mock).mockReset();
        (redisClient.exists as jest.Mock).mockResolvedValue(0);

        mockWhatsAppServiceInstance = new WhatsAppService();

        req = {
            ip: '127.0.0.1',
            headers: {},
            body: {},
            socket: {},
        } as any;

        res = {
            setHeader: jest.fn(),
            status: jest.fn().mockReturnThis(),
            json: jest.fn().mockReturnThis(),
        } as any;

        next = jest.fn();
    });

    describe('Helper Functions', () => {
        it('should classify commands into correct tiers', () => {
            expect(classifyCommand('SEND 10 @user')).toBe('FINANCIAL');
            expect(classifyCommand('CONTRIBUTE 100')).toBe('FINANCIAL');
            expect(classifyCommand('WITHDRAW 50')).toBe('FINANCIAL');
            expect(classifyCommand('BALANCE')).toBe('READ');
            expect(classifyCommand('BALANCE usdc')).toBe('READ');
            expect(classifyCommand('HELP')).toBe('GENERAL');
            expect(classifyCommand('CREATE GROUP')).toBe('GENERAL');
            expect(classifyCommand('unknown command')).toBe('GENERAL');
            expect(classifyCommand('')).toBe('GENERAL');
        });

        it('should extract message details from various request shapes', () => {
            // Shape 1: Parsed body
            const req1 = {
                body: {
                    object: 'whatsapp_business_account',
                    entry: [
                        {
                            changes: [
                                {
                                    value: {
                                        messages: [
                                            {
                                                from: '2348000000000',
                                                text: { body: 'SEND 10 @bob' },
                                            },
                                        ],
                                    },
                                },
                            ],
                        },
                    ],
                },
            };
            expect(extractMessageDetails(req1)).toEqual({
                phoneNumber: '2348000000000',
                commandText: 'SEND 10 @bob',
            });

            // Shape 2: Unparsed raw body buffer
            const payload = {
                object: 'whatsapp_business_account',
                entry: [
                    {
                        changes: [
                            {
                                value: {
                                    messages: [
                                        {
                                            from: '2349000000000',
                                            text: { body: 'BALANCE' },
                                        },
                                    ],
                                    field: 'messages',
                                },
                            },
                        ],
                    },
                ],
            };
            const req2 = {
                rawBody: Buffer.from(JSON.stringify(payload)),
            };
            expect(extractMessageDetails(req2)).toEqual({
                phoneNumber: '2349000000000',
                commandText: 'BALANCE',
            });
        });
    });

    describe('Rate Limiter Middleware (In-Memory Fallback Path)', () => {
        beforeEach(() => {
            setForceRedisFailure(true);
        });

        it('should allow up to 30 general command requests, then reject the 31st', async () => {
            req.body = {
                object: 'whatsapp_business_account',
                entry: [
                    {
                        changes: [
                            {
                                value: {
                                    messages: [
                                        {
                                            from: '1111111111',
                                            text: { body: 'HELP' },
                                        },
                                    ],
                                },
                            },
                        ],
                    },
                ],
            };

            // Call 30 times - all should be allowed (next() called)
            for (let i = 0; i < 30; i++) {
                await commandRateLimitMiddleware(req, res, next);
                expect(next).toHaveBeenCalledTimes(i + 1);
            }

            // Call 31st time - should be rejected with 429
            await commandRateLimitMiddleware(req, res, next);
            expect(next).toHaveBeenCalledTimes(30); // count remains 30
            expect(res.status).toHaveBeenCalledWith(429);
            expect(res.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(String));
            expect(res.json).toHaveBeenCalledWith({
                error: expect.stringContaining('Too many requests'),
            });
            expect(mockWhatsAppServiceInstance.sendMessage).toHaveBeenCalledWith(
                '1111111111',
                expect.stringContaining('too many requests')
            );
        });

        it('should enforce stricter limits (5/min) on financial commands', async () => {
            req.body = {
                object: 'whatsapp_business_account',
                entry: [
                    {
                        changes: [
                            {
                                value: {
                                    messages: [
                                        {
                                            from: '2222222222',
                                            text: { body: 'SEND 10 @user' },
                                        },
                                    ],
                                },
                            },
                        ],
                    },
                ],
            };

            // Call 5 times - allowed
            for (let i = 0; i < 5; i++) {
                await commandRateLimitMiddleware(req, res, next);
                expect(next).toHaveBeenCalledTimes(i + 1);
            }

            // Call 6th time - rejected
            await commandRateLimitMiddleware(req, res, next);
            expect(next).toHaveBeenCalledTimes(5);
            expect(res.status).toHaveBeenCalledWith(429);
        });

        it('should enforce limits of 10/min on BALANCE queries', async () => {
            req.body = {
                object: 'whatsapp_business_account',
                entry: [
                    {
                        changes: [
                            {
                                value: {
                                    messages: [
                                        {
                                            from: '3333333333',
                                            text: { body: 'BALANCE' },
                                        },
                                    ],
                                },
                            },
                        ],
                    },
                ],
            };

            // Call 10 times - allowed
            for (let i = 0; i < 10; i++) {
                await commandRateLimitMiddleware(req, res, next);
                expect(next).toHaveBeenCalledTimes(i + 1);
            }

            // Call 11th time - rejected
            await commandRateLimitMiddleware(req, res, next);
            expect(next).toHaveBeenCalledTimes(10);
            expect(res.status).toHaveBeenCalledWith(429);
        });

        it('should verify rate limits are per-user and not shared', async () => {
            const reqUserA = {
                body: {
                    object: 'whatsapp_business_account',
                    entry: [
                        {
                            changes: [
                                {
                                    value: {
                                        messages: [
                                            {
                                                from: 'user_a',
                                                text: { body: 'SEND 10 @user' },
                                            },
                                        ],
                                    },
                                },
                            ],
                        },
                    ],
                },
            } as any;

            const reqUserB = {
                body: {
                    object: 'whatsapp_business_account',
                    entry: [
                        {
                            changes: [
                                {
                                    value: {
                                        messages: [
                                            {
                                                from: 'user_b',
                                                text: { body: 'SEND 10 @user' },
                                            },
                                        ],
                                    },
                                },
                            ],
                        },
                    ],
                },
            } as any;

            // Exhaust User A's limit
            for (let i = 0; i < 5; i++) {
                const nextSpy = jest.fn();
                await commandRateLimitMiddleware(reqUserA, res, nextSpy);
                expect(nextSpy).toHaveBeenCalled();
            }
            const blockSpyA = jest.fn();
            await commandRateLimitMiddleware(reqUserA, res, blockSpyA);
            expect(blockSpyA).not.toHaveBeenCalled(); // Blocked

            // User B should still be allowed
            const nextSpyB = jest.fn();
            await commandRateLimitMiddleware(reqUserB, res, nextSpyB);
            expect(nextSpyB).toHaveBeenCalled(); // Allowed!
        });
    });

    describe('Rate Limiter Middleware (Redis Path)', () => {
        it('should use Redis script evaluation to verify limits', async () => {
            req.body = {
                object: 'whatsapp_business_account',
                entry: [
                    {
                        changes: [
                            {
                                value: {
                                    messages: [
                                        {
                                            from: '8888888888',
                                            text: { body: 'HELP' },
                                        },
                                    ],
                                },
                            },
                        ],
                    },
                ],
            };

            // Mock Redis response: [allowed_boolean_number, remaining_seconds]
            (redisClient.eval as jest.Mock).mockResolvedValueOnce([1, 0]);

            await commandRateLimitMiddleware(req, res, next);
            expect(redisClient.eval).toHaveBeenCalled();
            expect(next).toHaveBeenCalled();
            expect(res.status).not.toHaveBeenCalled();
        });

        it('should block request if Redis script returns blocked', async () => {
            req.body = {
                object: 'whatsapp_business_account',
                entry: [
                    {
                        changes: [
                            {
                                value: {
                                    messages: [
                                        {
                                            from: '8888888888',
                                            text: { body: 'HELP' },
                                        },
                                    ],
                                },
                            },
                        ],
                    },
                ],
            };

            (redisClient.eval as jest.Mock).mockResolvedValueOnce([0, 15]);

            await commandRateLimitMiddleware(req, res, next);
            expect(redisClient.eval).toHaveBeenCalled();
            expect(next).not.toHaveBeenCalled();
            expect(res.status).toHaveBeenCalledWith(429);
            expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '15');
            expect(mockWhatsAppServiceInstance.sendMessage).toHaveBeenCalledWith(
                '8888888888',
                expect.stringContaining('15 seconds')
            );
        });

        it('should fallback to in-memory and log warning if Redis status is not connected', async () => {
            (redisClient.status as any) = 'closed';
            const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

            req.body = {
                object: 'whatsapp_business_account',
                entry: [
                    {
                        changes: [
                            {
                                value: {
                                    messages: [
                                        {
                                            from: '9999999999',
                                            text: { body: 'HELP' },
                                        },
                                    ],
                                },
                            },
                        ],
                    },
                ],
            };

            await commandRateLimitMiddleware(req, res, next);
            expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Redis is not connected'));
            expect(next).toHaveBeenCalled();
            consoleSpy.mockRestore();
        });

        it('should fallback to in-memory if Redis eval throws an error', async () => {
            (redisClient.status as any) = 'ready';
            (redisClient.eval as jest.Mock).mockRejectedValueOnce(new Error('Redis connection error'));
            const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

            req.body = {
                object: 'whatsapp_business_account',
                entry: [
                    {
                        changes: [
                            {
                                value: {
                                    messages: [
                                        {
                                            from: '9999999999',
                                            text: { body: 'HELP' },
                                        },
                                    ],
                                },
                            },
                        ],
                    },
                ],
            };

            await commandRateLimitMiddleware(req, res, next);
            expect(consoleSpy.mock.calls[0][0]).toContain('Redis command failed');
            expect(next).toHaveBeenCalled();
            consoleSpy.mockRestore();
        });
    });

    describe('Abuse Detection Service', () => {
        beforeEach(() => {
            setForceRedisFailure(true);
            abuseDetectionService.setForceRedisFailure(true);
        });

        it('should flag user for review when hitting financial rate limit 3 times within 10 minutes', async () => {
            const phoneNumber = '1234567890';
            const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

            // Verify not flagged initially
            expect(await abuseDetectionService.isUserFlagged(phoneNumber)).toBe(false);

            // Record 1st hit
            await abuseDetectionService.recordFinancialLimitHit(phoneNumber, 'SEND 10 @user');
            expect(await abuseDetectionService.isUserFlagged(phoneNumber)).toBe(false);

            // Record 2nd hit
            await abuseDetectionService.recordFinancialLimitHit(phoneNumber, 'CONTRIBUTE 20');
            expect(await abuseDetectionService.isUserFlagged(phoneNumber)).toBe(false);

            // Record 3rd hit
            await abuseDetectionService.recordFinancialLimitHit(phoneNumber, 'WITHDRAW 5');
            
            // Should now be flagged
            expect(await abuseDetectionService.isUserFlagged(phoneNumber)).toBe(true);
            expect(consoleSpy.mock.calls[0][0]).toContain('[ABUSE DETECTION] User flagged for review');

            consoleSpy.mockRestore();
        });

        it('should support admin notifications when ADMIN_PHONE_NUMBER env is defined', async () => {
            process.env.ADMIN_PHONE_NUMBER = '9991119999';
            const phoneNumber = '5555555555';

            await abuseDetectionService.recordFinancialLimitHit(phoneNumber, 'SEND 1');
            await abuseDetectionService.recordFinancialLimitHit(phoneNumber, 'SEND 2');
            await abuseDetectionService.recordFinancialLimitHit(phoneNumber, 'SEND 3');

            expect(mockWhatsAppServiceInstance.sendMessage).toHaveBeenCalledWith(
                '9991119999',
                expect.stringContaining('ABUSE DETECTED')
            );
            delete process.env.ADMIN_PHONE_NUMBER;
        });

        it('should track flags and command history in Redis when Redis is available', async () => {
            abuseDetectionService.setForceRedisFailure(false);
            const phoneNumber = '7777777777';

            // Mock Redis operations
            (redisClient.lpush as jest.Mock).mockResolvedValue(1);
            (redisClient.zadd as jest.Mock).mockResolvedValue(1);
            (redisClient.zremrangebyscore as jest.Mock).mockResolvedValue(0);
            (redisClient.zcard as jest.Mock).mockResolvedValue(3); // Simulate 3 hits
            (redisClient.exists as jest.Mock).mockResolvedValue(1); // Simulate flag exists

            await abuseDetectionService.recordFinancialLimitHit(phoneNumber, 'SEND 10');

            expect(redisClient.zadd).toHaveBeenCalled();
            expect(redisClient.set).toHaveBeenCalledWith(
                `abuse_flag:${phoneNumber}`,
                expect.stringContaining(phoneNumber),
                'EX',
                24 * 60 * 60
            );

            expect(await abuseDetectionService.isUserFlagged(phoneNumber)).toBe(true);
        });
    });
});
