import { Router } from 'express';
import { BotController } from '../controllers/bot.controller';
import { webhookRateLimiter } from '../middleware/rateLimiter';

import { verifySignature } from '../middleware/verifySignature';

const router = Router();
const botController = new BotController();

router.get('/webhook', webhookRateLimiter, botController.verifyWebhook.bind(botController));
router.post('/webhook', webhookRateLimiter, verifySignature, botController.handleMessage.bind(botController));

export default router;
