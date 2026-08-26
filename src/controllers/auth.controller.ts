import { Request, Response } from 'express';
import { authService } from '../services/auth.service';

export const getChallenge = (req: Request, res: Response) => {
    try {
        const { account } = req.query;

        if (!account || typeof account !== 'string') {
            res.status(400).json({ error: 'Missing or invalid account parameter' });
            return;
        }

        const transactionXdr = authService.generateChallenge(account);
        res.json({ transaction: transactionXdr });
    } catch (error: any) {
        console.error('Error generating challenge:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

export const getToken = async (req: Request, res: Response) => {
    try {
        const { transaction } = req.body;

        if (!transaction || typeof transaction !== 'string') {
            res.status(400).json({ error: 'Missing or invalid transaction parameter' });
            return;
        }

        const { token, account } = await authService.verifyChallengeAndGenerateToken(transaction);
        res.json({ token, account });
    } catch (error: any) {
        console.error('Error verifying challenge:', error);
        res.status(401).json({ error: error.message || 'Invalid challenge transaction' });
    }
};
