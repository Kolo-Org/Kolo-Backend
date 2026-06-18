import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config/env';

export interface RequestWithRawBody extends Request {
    rawBody?: Buffer;
}

export const verifySignature = (req: RequestWithRawBody, res: Response, next: NextFunction): void => {
    const signature = req.headers['x-hub-signature-256'] as string;

    if (!signature) {
        res.status(401).json({ error: 'Missing signature' });
        return;
    }

    if (!req.rawBody) {
        res.status(500).json({ error: 'Raw body missing' });
        return;
    }

    const expectedSignature = `sha256=${crypto
        .createHmac('sha256', config.WHATSAPP_APP_SECRET)
        .update(req.rawBody)
        .digest('hex')}`;

    if (signature.length !== expectedSignature.length) {
        res.status(401).json({ error: 'Invalid signature length' });
        return;
    }

    if (!crypto.timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expectedSignature, 'utf8'))) {
        res.status(401).json({ error: 'Invalid signature' });
        return;
    }

    next();
};
