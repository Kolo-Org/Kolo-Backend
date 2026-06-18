import type { Request, Response } from 'express';
import { config } from '../config/env';
import { enqueueMessage } from '../queue/message.queue';

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

    public async handleMessage(req: Request, res: Response) {
        const body = req.body;

        if (body.object) {
            if (
                body.entry &&
                body.entry[0].changes &&
                body.entry[0].changes[0] &&
                body.entry[0].changes[0].value.messages &&
                body.entry[0].changes[0].value.messages[0]
            ) {
                const from = body.entry[0].changes[0].value.messages[0].from;
                const msgBody = body.entry[0].changes[0].value.messages[0].text?.body || '';

                if (msgBody) {
                    console.log(`Received message from ${from}: ${msgBody}`);

                    await enqueueMessage({
                        from,
                        msgBody,
                        messageTimestamp: Date.now(),
                    });
                }
            }
            res.sendStatus(200);
        } else {
            res.sendStatus(404);
        }
    }
}
