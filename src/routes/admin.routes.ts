import { Router, Request, Response, NextFunction } from 'express';
import { keyRotationQueue } from '../queue/key-rotation.queue';

const router = Router();

const adminAuth = (req: Request, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    const adminToken = process.env.ADMIN_TOKEN;
    
    if (!adminToken || !authHeader || authHeader !== `Bearer ${adminToken}`) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    next();
};

router.use(adminAuth);
router.post('/key-rotation/start', async (req, res) => {
    try {
        const activeJobs = await keyRotationQueue.getActiveCount();
        const waitingJobs = await keyRotationQueue.getWaitingCount();

        if (activeJobs > 0 || waitingJobs > 0) {
            return res.status(400).json({ error: 'A key rotation job is already running or queued.' });
        }

        const job = await keyRotationQueue.add('rotate-keys', {});
        return res.json({ message: 'Key rotation started', jobId: job.id });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to start key rotation' });
    }
});

router.get('/key-rotation/status', async (req, res) => {
    try {
        const activeCount = await keyRotationQueue.getActiveCount();
        const waitingCount = await keyRotationQueue.getWaitingCount();
        const completedCount = await keyRotationQueue.getCompletedCount();
        const failedCount = await keyRotationQueue.getFailedCount();

        return res.json({
            status: activeCount > 0 ? 'running' : 'idle',
            metrics: {
                active: activeCount,
                waiting: waitingCount,
                completed: completedCount,
                failed: failedCount
            }
        });
    } catch (error) {
        return res.status(500).json({ error: 'Failed to get key rotation status' });
    }
});

export default router;
