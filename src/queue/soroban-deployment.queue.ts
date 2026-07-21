import { Queue, Job } from 'bullmq';
import { config } from '../config/env';
import { redisClient } from '../lib/redis';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const connection = { url: config.REDIS_URL };

const defaultJobOptions = {
    attempts: 3,
    backoff: {
        type: 'exponential' as const,
        delay: 1000,
    },
    removeOnComplete: true,
    removeOnFail: false, // Keep failed jobs in DLQ for manual inspection and retry
};

let queueInstance: Queue | null = null;

export function getSorobanDeploymentQueue(): Queue {
    if (!queueInstance) {
        queueInstance = new Queue('soroban-deployment', {
            connection,
            defaultJobOptions,
        });
    }
    return queueInstance;
}

/**
 * Enqueues an async contract deployment job for a group.
 */
export async function enqueueContractDeployment(groupId: string): Promise<Job | null> {
    if (redisClient.status !== 'ready') {
        console.warn('Redis is not ready, unable to enqueue contract deployment immediately.');
        return null;
    }

    const queue = getSorobanDeploymentQueue();
    const jobId = `deploy-contract:${groupId}`;

    return await queue.add(
        'deploy-contract',
        { groupId },
        { jobId }
    );
}

/**
 * Dead-Letter Queue (DLQ): Returns all failed deployments from the database.
 */
export async function getFailedDeployments(): Promise<any[]> {
    return await prisma.savingsGroup.findMany({
        where: { deploymentStatus: 'FAILED' },
        include: { members: { include: { user: true } } },
    });
}

/**
 * Dead-Letter Queue (DLQ): Manually retries a failed deployment for a group.
 */
export async function retryFailedDeployment(groupId: string): Promise<Job | null> {
    // Reset group deployment status to PENDING and clear error
    await prisma.savingsGroup.update({
        where: { id: groupId },
        data: {
            deploymentStatus: 'PENDING',
            deploymentError: null,
        },
    });

    const queue = getSorobanDeploymentQueue();
    const jobId = `deploy-contract:${groupId}:${Date.now()}`;

    return await queue.add(
        'deploy-contract',
        { groupId },
        { jobId }
    );
}

export async function closeSorobanDeploymentQueue(): Promise<void> {
    if (queueInstance) {
        await queueInstance.close();
        queueInstance = null;
    }
}
