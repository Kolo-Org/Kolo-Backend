import { Request, Response, NextFunction } from 'express';
import { prisma } from '../lib/prisma';
import { redisClient } from '../lib/redis';
import { WhatsAppService } from '../services/whatsapp.service';
import { t, initI18n } from '../services/locale.service';
import { abuseDetectionService } from '../services/abuse-detection.service';

const whatsappService = new WhatsAppService();

export type CommandTier = 'FINANCIAL' | 'READ' | 'GENERAL';

// In-memory store for rate limiting fallback when Redis is down
const inMemoryStore = new Map<string, number[]>();

// Toggling mechanism for testing Redis failure scenarios
let forceRedisFailure = false;

export function setForceRedisFailure(val: boolean) {
    forceRedisFailure = val;
}

export function clearInMemoryStore() {
    inMemoryStore.clear();
}

/**
 * Classifies WhatsApp messages based on the command text.
 * - FINANCIAL: SEND, CONTRIBUTE, WITHDRAW (Limit: 5/min)
 * - READ: BALANCE (Limit: 10/min)
 * - GENERAL: All other commands/text (Limit: 30/min)
 */
export function classifyCommand(text: string): CommandTier {
    const tokens = text.trim().split(/\s+/);
    if (tokens.length === 0) return 'GENERAL';

    const cmd1 = tokens[0].toUpperCase();

    if (cmd1 === 'SEND' || cmd1 === 'CONTRIBUTE' || cmd1 === 'WITHDRAW') {
        return 'FINANCIAL';
    }

    if (cmd1 === 'BALANCE') {
        return 'READ';
    }

    return 'GENERAL';
}

/**
 * Minimally parses request to extract the WhatsApp message body and sender.
 * Useful if express.json() is not run yet, or as a defensive guard.
 */
export function extractMessageDetails(req: any): { phoneNumber: string | null; commandText: string | null } {
    let body = req.body;
    if (!body && req.rawBody) {
        try {
            body = JSON.parse(req.rawBody.toString('utf8'));
        } catch (e) {
            // ignore JSON parse error
        }
    }

    const message = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const from = message?.from;
    const msgBody = message?.text?.body;

    return {
        phoneNumber: typeof from === 'string' ? from : null,
        commandText: typeof msgBody === 'string' ? msgBody : null,
    };
}

// Lua script to implement sliding window rate limiting
const slidingWindowScript = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local requestId = ARGV[4]

-- Remove timestamps older than (now - windowMs)
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - windowMs)

-- Count current number of requests in the window
local currentRequests = redis.call('ZCARD', key)

if currentRequests < limit then
    -- Add the request timestamp
    redis.call('ZADD', key, now, requestId)
    -- Set TTL of the key to twice the window size (to clean up)
    redis.call('PEXPIRE', key, windowMs * 2)
    return {1, 0} -- allowed, 0 remaining seconds
else
    -- Exceeded limit. Get the oldest element's score to calculate remaining time
    local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    local remainingMs = 0
    if oldest[2] then
        remainingMs = tonumber(oldest[2]) + windowMs - now
    end
    local remainingSeconds = math.max(0, math.ceil(remainingMs / 1000))
    return {0, remainingSeconds} -- blocked, remainingSeconds
end
`;

/**
 * Helper to perform the sliding window check using Redis or the in-memory fallback.
 */
async function checkLimit(
    key: string,
    limit: number,
    windowMs: number
): Promise<{ allowed: boolean; remainingSeconds: number }> {
    let useInMemory = forceRedisFailure;

    if (!useInMemory) {
        // Check if Redis client is connected (ready or connect status)
        const isReady = redisClient.status === 'ready' || redisClient.status === 'connect';
        if (!isReady) {
            useInMemory = true;
            console.warn('Redis is not connected. Falling back to in-memory rate limiting.');
        }
    }

    if (!useInMemory) {
        try {
            const requestId = `${Date.now()}-${Math.random()}`;
            const result = (await redisClient.eval(
                slidingWindowScript,
                1,
                key,
                Date.now().toString(),
                windowMs.toString(),
                limit.toString(),
                requestId
            )) as [number, number];

            return {
                allowed: result[0] === 1,
                remainingSeconds: result[1],
            };
        } catch (err) {
            console.warn('Redis command failed. Falling back to in-memory rate limiting.', err);
            useInMemory = true;
        }
    }

    // In-memory fallback
    const now = Date.now();
    const timestamps = inMemoryStore.get(key) || [];

    // Filter out expired timestamps
    const validTimestamps = timestamps.filter((t) => t > now - windowMs);

    if (validTimestamps.length < limit) {
        validTimestamps.push(now);
        inMemoryStore.set(key, validTimestamps);
        return { allowed: true, remainingSeconds: 0 };
    } else {
        const oldest = validTimestamps[0];
        const remainingMs = oldest + windowMs - now;
        const remainingSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
        return { allowed: false, remainingSeconds };
    }
}

export const commandRateLimitMiddleware = async (
    req: Request,
    res: Response,
    next: NextFunction
): Promise<void> => {
    // 1. Extract details from the request
    const { phoneNumber, commandText } = extractMessageDetails(req);

    // Default parameters
    const windowMs = 60 * 1000; // 1 minute window
    let tier: CommandTier = 'GENERAL';
    let limit = 30; // default GENERAL limit
    let isUser = false;
    let rateLimitKey = '';

    if (phoneNumber) {
        isUser = true;
        rateLimitKey = `rate_limit:${phoneNumber}`;
        if (commandText) {
            tier = classifyCommand(commandText);
            rateLimitKey = `rate_limit:${tier}:${phoneNumber}`;
        }
    } else {
        // Fallback key: IP address (e.g. for GET requests / webhook verifications / API calls)
        const ip = req.ip || req.socket?.remoteAddress || 'unknown';
        rateLimitKey = `rate_limit:ip:${ip}`;
    }

    // Map limits based on tier
    if (tier === 'FINANCIAL') {
        limit = 5;
    } else if (tier === 'READ') {
        limit = 10;
    }

    // 2. Perform the sliding window rate limit check
    const { allowed, remainingSeconds } = await checkLimit(rateLimitKey, limit, windowMs);

    if (!allowed) {
        // Exceeded limit:
        // Set Retry-After header
        res.setHeader('Retry-After', remainingSeconds.toString());

        if (isUser && phoneNumber) {
            // Fetch user preferred language
            let lang = 'en';
            try {
                await initI18n();
                const user = await prisma.user.findUnique({ where: { phoneNumber } }) as any;
                if (user && user.language) {
                    lang = user.language;
                }
            } catch (e) {
                // Ignore DB read failure in rate limiter to prevent denial of service
            }

            const warningMsg = t('rate_limit.exceeded', lang, { remainingSeconds });
            // Send message via WhatsApp
            whatsappService.sendMessage(phoneNumber, warningMsg).catch((err) => {
                console.error('Failed to send WhatsApp rate limit notification:', err);
            });

            // If financial rate limit is hit, record this hit in abuse detection
            if (tier === 'FINANCIAL') {
                try {
                    await abuseDetectionService.recordFinancialLimitHit(phoneNumber, commandText || '');
                } catch (err) {
                    console.error('Failed to record financial limit hit:', err);
                }
            }
        }

        // Return 429 Too Many Requests response
        res.status(429).json({
            error: `Too many requests. Please wait ${remainingSeconds} seconds.`,
        });
        return;
    }

    // Allowed:
    if (isUser && phoneNumber && commandText) {
        // Record successful command in history
        abuseDetectionService.recordCommand(phoneNumber, commandText).catch((err) => {
            console.error('Failed to record command in abuse detection service:', err);
        });
    }

    next();
};
