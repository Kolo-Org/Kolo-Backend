import type { Request, Response } from 'express';
import { config } from '../config/env';
import { enqueueMessage, type MessageJobData } from '../queue/message.queue';

/**
 * Hard upper bound on how long we wait for a message to be enqueued before
 * giving up. Without this, a hung Redis/BullMQ connection would keep the
 * webhook request (and the WhatsApp delivery) open indefinitely.
 */
const ENQUEUE_TIMEOUT_MS = 10_000;

/**
 * Strict typing for the subset of the WhatsApp Cloud API webhook payload that
 * we consume. The payload is attacker-influenced, so every field is optional
 * and must be treated as untrusted at runtime.
 */
interface WhatsAppTextMessage {
    from?: string;
    text?: { body?: string };
}

interface WhatsAppChangeValue {
    messages?: WhatsAppTextMessage[];
}

interface WhatsAppChange {
    value?: WhatsAppChangeValue;
}

interface WhatsAppEntry {
    changes?: WhatsAppChange[];
}

interface WhatsAppWebhookBody {
    object?: unknown;
    entry?: WhatsAppEntry[];
}

export interface IncomingTextMessage {
    from: string;
    msgBody: string;
}

export class BotController {
    public verifyWebhook(req: Request, res: Response) {
        const mode = req.query['hub.mode'];
        const token = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];

        if (mode && token) {
            if (mode === 'subscribe' && token === config.VERIFY_TOKEN) {
                console.log('WEBHOOK_VERIFIED');
                res.status(200).send(challenge);
            } else {
                res.sendStatus(403);
            }
        } else {
            res.sendStatus(400);
        }
    }

    /**
     * Safely extract the first inbound text message from a (possibly malformed
     * or malicious) webhook body. Optional chaining is used end-to-end so a
     * partial or garbage payload can never throw a TypeError — the previous
     * guard chain crashed on inputs such as `{ object: 'x', entry: [] }`.
     * Returns null when there is no actionable text message.
     */
    private extractTextMessage(body: WhatsAppWebhookBody): IncomingTextMessage | null {
        const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        const from = message?.from;
        const msgBody = message?.text?.body;

        if (typeof from !== 'string' || typeof msgBody !== 'string' || msgBody.length === 0) {
            return null;
        }

        return { from, msgBody };
    }

    public async handleMessage(req: Request, res: Response) {
        const body = (req.body ?? {}) as WhatsAppWebhookBody;

        if (!body.object) {
            res.sendStatus(404);
            return;
        }

        const message = this.extractTextMessage(body);

        if (!message) {
            // Valid webhook event that carries nothing for us to act on
            // (status update, empty body, non-text message, etc.). Acknowledge.
            res.sendStatus(200);
            return;
        }

        console.log('Received message');

        try {
            await this.enqueueWithTimeout({
                from: message.from,
                msgBody: message.msgBody,
                messageTimestamp: Date.now(),
            });
        } catch (err) {
            // Never let a queue/Redis failure surface as an unhandled promise
            // rejection. Returning 500 makes WhatsApp retry delivery rather
            // than silently dropping the message — important for a financial
            // app where a lost message can mean a lost transaction.
            console.error('Failed to enqueue webhook message:', err);
            res.sendStatus(500);
            return;
        }

        res.sendStatus(200);
    }

    /**
     * Enqueue a message with a hard timeout so a stalled queue connection can
     * never hang the webhook. Resolves once the job is queued; rejects on
     * enqueue error or when ENQUEUE_TIMEOUT_MS elapses. The timer is always
     * cleared so it cannot keep the event loop alive.
     */
    private async enqueueWithTimeout(data: MessageJobData): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<never>((_, reject) => {
            timer = setTimeout(
                () => reject(new Error(`enqueueMessage timed out after ${ENQUEUE_TIMEOUT_MS}ms`)),
                ENQUEUE_TIMEOUT_MS,
            );
        });

        try {
            await Promise.race([enqueueMessage(data), timeout]);
        } finally {
            if (timer) {
                clearTimeout(timer);
            }
        }
    }
}
