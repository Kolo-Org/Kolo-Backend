import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import Redis from 'ioredis';
import { config } from '../config/env';

// Initialize Redis client using the existing configuration
const redisClient = new Redis(config.REDIS_URL);

export const customKeyGenerator = (req: any): string => {
    // Attempt to extract the WhatsApp sender's phone number
    const body = req.body;
    if (
        body?.object &&
        body.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from
    ) {
        return body.entry[0].changes[0].value.messages[0].from;
    }

    // Fallback to IP address (e.g., for webhook verification GET requests)
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    return ip !== 'unknown' ? ipKeyGenerator(ip) : ip;
};

export const webhookRateLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    limit: 100, // Limit each key to 100 requests per window
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers

    // Redis store configuration
    store: new RedisStore({
        // @ts-expect-error - rate-limit-redis types might not perfectly align with ioredis call signature
        sendCommand: (...args: string[]) => redisClient.call(...args),
    }),

    // Custom key generator
    keyGenerator: customKeyGenerator,

    // Custom handler for 429 response
    handler: (req, res, next, options) => {
        res.status(options.statusCode).json({
            error: 'Too many requests, please try again later.',
        });
    },
});
