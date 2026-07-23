import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config/env';
import { redisClient } from '../lib/redis';
import { observabilityService } from '../services/observability.service';

export interface RequestWithRawBody extends Request {
    rawBody?: Buffer;
}

const STALE_WEBHOOK_SECONDS = 300;
const REPLAY_TTL_SECONDS = 600;
const REDIS_KEY_PREFIX = 'webhook:id:';

interface WhatsAppMessage {
    id?: string;
    timestamp?: string;
}

interface WhatsAppStatus {
    id?: string;
    timestamp?: string;
}

interface WhatsAppWebhookBody {
    entry?: Array<{
        changes?: Array<{
            value?: {
                messages?: WhatsAppMessage[];
                statuses?: WhatsAppStatus[];
            };
        }>;
    }>;
}

function getSourceIp(req: Request): string {
    return req.ip || req.socket?.remoteAddress || 'unknown';
}

function truncateSignature(sig: string): string {
    if (sig.length <= 12) return sig;
    return `${sig.slice(0, 8)}...${sig.slice(-4)}`;
}

function extractReplayInfo(body: unknown): { id: string; timestamp: number } | null {
    const payload = body as WhatsAppWebhookBody;
    const value = payload?.entry?.[0]?.changes?.[0]?.value;

    const message = value?.messages?.[0];
    if (message?.id && message?.timestamp) {
        const ts = parseInt(message.timestamp, 10);
        if (!isNaN(ts)) return { id: message.id, timestamp: ts };
    }

    const status = value?.statuses?.[0];
    if (status?.id && status?.timestamp) {
        const ts = parseInt(status.timestamp, 10);
        if (!isNaN(ts)) return { id: status.id, timestamp: ts };
    }

    return null;
}

export const webhookSignatureMiddleware = async (
    req: RequestWithRawBody,
    res: Response,
    next: NextFunction,
): Promise<void> => {
    const signature = req.headers['x-hub-signature-256'] as string | undefined;

    if (!signature) {
        observabilityService.logError('Webhook signature verification failed', undefined, {
            ip: getSourceIp(req),
            signature: null,
            reason: 'missing signature header',
        });
        res.status(403).json({ error: 'Missing signature' });
        return;
    }

    if (!req.rawBody) {
        observabilityService.logError('Webhook signature verification failed', undefined, {
            ip: getSourceIp(req),
            signature: truncateSignature(signature),
            reason: 'raw body missing',
        });
        res.status(500).json({ error: 'Raw body missing' });
        return;
    }

    const expectedSignature = `sha256=${crypto
        .createHmac('sha256', config.WHATSAPP_APP_SECRET)
        .update(req.rawBody)
        .digest('hex')}`;

    if (
        signature.length !== expectedSignature.length ||
        !crypto.timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expectedSignature, 'utf8'))
    ) {
        observabilityService.logError('Webhook signature verification failed', undefined, {
            ip: getSourceIp(req),
            signature: truncateSignature(signature),
            reason: 'invalid signature',
        });
        res.status(403).json({ error: 'Invalid signature' });
        return;
    }

    const replayInfo = extractReplayInfo(req.body);

    if (replayInfo) {
        const nowSec = Math.floor(Date.now() / 1000);
        if (Math.abs(nowSec - replayInfo.timestamp) > STALE_WEBHOOK_SECONDS) {
            res.status(403).json({ error: 'Stale webhook' });
            return;
        }

        try {
            const redisKey = `${REDIS_KEY_PREFIX}${replayInfo.id}`;
            const stored = await redisClient.set(redisKey, '1', 'EX', REPLAY_TTL_SECONDS, 'NX');

            if (stored === null) {
                res.status(403).json({ error: 'Duplicate webhook' });
                return;
            }
        } catch (redisError) {
            observabilityService.logError('Redis unavailable for replay checking, proceeding without replay protection', redisError, {
                ip: getSourceIp(req),
            });
        }
    }

    next();
};
