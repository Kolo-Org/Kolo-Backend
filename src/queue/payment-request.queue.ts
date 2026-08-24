import { Queue } from 'bullmq';
import { redisClient } from '../lib/redis';

export const PAYMENT_REQUEST_QUEUE_NAME = 'payment-request-queue';

export const JOB_COMPLETE_REQUEST = 'complete-request';
export const JOB_EXPIRE_REQUEST = 'expire-request';

let queueInstance: Queue | null = null;

function getQueue(): Queue {
    if (!queueInstance) {
        queueInstance = new Queue(PAYMENT_REQUEST_QUEUE_NAME, {
            connection: redisClient as any,
        });
    }
    return queueInstance;
}

/** Schedules the automatic completion of an accepted request. */
export async function scheduleRequestCompletion(requestId: string): Promise<void> {
    await getQueue().add(
        JOB_COMPLETE_REQUEST,
        { requestId },
        { delay: 5 * 60 * 1000, jobId: `complete:${requestId}`, removeOnComplete: true },
    );
}

/** Schedules expiry for a pending request at its expiresAt time. */
export async function scheduleRequestExpiry(requestId: string, expiresAt: Date): Promise<void> {
    const delay = Math.max(0, expiresAt.getTime() - Date.now());
    await getQueue().add(
        JOB_EXPIRE_REQUEST,
        { requestId },
        { delay, jobId: `expire:${requestId}`, removeOnComplete: true },
    );
}

export async function closePaymentRequestQueue(): Promise<void> {
    if (queueInstance) {
        await queueInstance.close();
        queueInstance = null;
    }
}
