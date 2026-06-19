import { Router } from 'express';
import { BotController } from '../controllers/bot.controller';
import { webhookRateLimiter } from '../middleware/rateLimiter';

const router = Router();
const botController = new BotController();

router.get('/webhook', webhookRateLimiter, botController.verifyWebhook.bind(botController));
router.post('/webhook', webhookRateLimiter, botController.handleMessage.bind(botController));

export default router;
