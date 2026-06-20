import type { Request, Response } from 'express';
import { config } from '../config/env';
import { enqueueMessage } from '../queue/message.queue';

/**
 * Minimal, defensively-typed shape of the WhatsApp Cloud API webhook payload.
 * Every field is optional because the payload is attacker-controllable: the
 * webhook is public, so we must treat the body as untrusted and never assume a
 * field exists. We only model the slice we actually read.
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

interface WhatsAppWebhookPayload {
    object?: string;
    entry?: WhatsAppEntry[];
}

/**
 * Narrow an unknown caught value to a human-readable message without assuming
 * it is an `Error`. Caught values are typed `unknown` under strict mode, so a
 * type guard is required before touching `.message`.
 */
function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    if (typeof error === 'string') {
        return error;
    }
    return 'Unknown error';
}

export class BotController {
    public verifyWebhook(req: Request, res: Response): void {
        const mode = req.query['hub.mode'];
        const token = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];

        if (typeof mode !== 'string' || typeof token !== 'string') {
            res.sendStatus(400);
            return;
        }

        if (mode === 'subscribe' && token === config.VERIFY_TOKEN) {
            console.log('WEBHOOK_VERIFIED');
            res.status(200).send(typeof challenge === 'string' ? challenge : '');
            return;
        }

        res.sendStatus(403);
    }

    public async handleMessage(req: Request, res: Response): Promise<void> {
        const body = req.body as WhatsAppWebhookPayload;

        if (!body || !body.object) {
            res.sendStatus(404);
            return;
        }

        const message = this.extractTextMessage(body);

        if (message && message.from && message.body) {
            console.log('Received message');

            try {
                await enqueueMessage({
                    from: message.from,
                    msgBody: message.body,
                    messageTimestamp: Date.now(),
                });
            } catch (error: unknown) {
                // Swallow enqueue failures: WhatsApp requires a 200 to stop
                // redelivery storms. Surfacing a 5xx here would trigger retries.
                console.error('Failed to enqueue message:', getErrorMessage(error));
            }
        }

        res.sendStatus(200);
    }

    /**
     * Safely pull the first inbound text message out of the webhook payload.
     * Returns null when the payload does not contain a usable text message.
     */
    private extractTextMessage(
        body: WhatsAppWebhookPayload,
    ): { from: string; body: string } | null {
        const message = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
        const from = message?.from;
        const text = message?.text?.body;

        if (typeof from !== 'string' || typeof text !== 'string' || text.length === 0) {
            return null;
        }

        return { from, body: text };
    }
}
