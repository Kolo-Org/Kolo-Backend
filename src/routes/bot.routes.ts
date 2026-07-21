import { Router } from 'express';
import { BotController } from '../controllers/bot.controller';
import { webhookRateLimiter } from '../middleware/rateLimiter';

import { webhookSignatureMiddleware } from '../middleware/webhook-signature.middleware';

const router = Router();
const botController = new BotController();

router.get('/webhook', webhookRateLimiter, botController.verifyWebhook.bind(botController));
router.post('/webhook', webhookRateLimiter, webhookSignatureMiddleware, botController.handleMessage.bind(botController));

export default router;
