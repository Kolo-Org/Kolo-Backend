import { Router } from 'express';
import { BotController } from '../controllers/bot.controller';
import { commandRateLimitMiddleware } from '../middleware/command-rate-limit.middleware';
import { webhookSignatureMiddleware } from '../middleware/webhook-signature.middleware';

const router = Router();
const botController = new BotController();

router.get('/webhook', commandRateLimitMiddleware, botController.verifyWebhook.bind(botController));
router.post('/webhook', commandRateLimitMiddleware, webhookSignatureMiddleware, botController.handleMessage.bind(botController));

export default router;
