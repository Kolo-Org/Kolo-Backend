import { Router } from 'express';
import { getChallenge, getToken } from '../controllers/auth.controller';

const router = Router();

router.get('/challenge', getChallenge);
router.post('/token', getToken);

export default router;
