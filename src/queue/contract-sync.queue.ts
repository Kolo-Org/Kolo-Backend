import { Queue, Job } from 'bullmq';
import { config } from '../config/env';

const connection = { url: config.REDIS_URL };

const defaultJobOptions = {
    attempts: 3,
    backoff: {
        type: 'exponential' as const,
        delay: 5000,
    },
    removeOnComplete: true,
    removeOnFail: false,
};

let queueInstance: Queue | null = null;

/**
 * Lazy-initialises and returns the contract-sync BullMQ queue.
 * The queue drives the reconciliation worker that compares on-chain
 * Soroban contribution state with the backend Prisma DB every 5 minutes.
 */
export function getContractSyncQueue(): Queue {
    if (!queueInstance) {
        queueInstance = new Queue('contract-sync', {
            connection,
            defaultJobOptions,
        });
    }
    return queueInstance;
}

/**
 * Schedules the repeating reconciliation job if it is not already registered.
 * Safe to call multiple times — BullMQ deduplicates by `jobId`.
 */
export async function scheduleReconciliation(): Promise<void> {
    const queue = getContractSyncQueue();

    // Remove any stale repeatable jobs before registering the current schedule.
    const repeatableJobs = await queue.getRepeatableJobs();
    for (const job of repeatableJobs) {
        if (job.name === 'reconcile') {
            await queue.removeRepeatableByKey(job.key);
        }
    }

    await queue.add(
        'reconcile',
        {},
        {
            repeat: { pattern: '*/5 * * * *' }, // every 5 minutes
            jobId: 'contract-sync:reconcile',
        },
    );
}

export async function closeContractSyncQueue(): Promise<void> {
    if (queueInstance) {
        await queueInstance.close();
        queueInstance = null;
    }
}
