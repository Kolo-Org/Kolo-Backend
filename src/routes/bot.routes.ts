import { Router } from 'express';
import { BotController } from '../controllers/bot.controller';

import { verifySignature } from '../middleware/verifySignature';

const router = Router();
const botController = new BotController();

router.get('/webhook', botController.verifyWebhook.bind(botController));
router.post('/webhook', verifySignature, botController.handleMessage.bind(botController));

export default router;
