import { Queue, Job } from 'bullmq';
import { config } from '../config/env';
import { redisClient } from '../lib/redis';

const connection = { url: config.REDIS_URL };

const defaultJobOptions = {
    attempts: 3,
    backoff: {
        type: 'exponential' as const,
        delay: 1000,
    },
    removeOnComplete: true,
    removeOnFail: false,
};

let queueInstance: Queue | null = null;

function getQueue(): Queue {
    if (!queueInstance) {
        queueInstance = new Queue('contribution-scheduling', {
            connection,
            defaultJobOptions,
        });
    }
    return queueInstance;
}

export function getCronPattern(frequency: string): string {
    switch (frequency.toUpperCase()) {
        case 'WEEKLY':
            return '0 9 * * 1'; // Monday 9 AM UTC
        case 'BIWEEKLY':
            return '0 9 * * 1/2'; // Every other Monday
        case 'MONTHLY':
            return '0 9 1 * *'; // 1st of each month
        default:
            throw new Error(`Unsupported frequency: ${frequency}`);
    }
}

export async function scheduleGroupCycle(groupId: string, frequency: string): Promise<string | null> {
    if (redisClient.status !== 'ready') {
        console.warn('Redis is down, unable to schedule group cycle immediately. Retrying on next startup.');
        return null;
    }

    const queue = getQueue();
    const cron = getCronPattern(frequency);
    const jobId = `cycle-start:${groupId}`;
    
    // We add a repeatable job for the cycle start
    await queue.add(
        'cycle-start',
        { groupId, frequency },
        {
            jobId,
            repeat: {
                pattern: cron,
            },
        }
    );
    
    return jobId;
}

export async function removeGroupCycle(groupId: string, frequency: string): Promise<void> {
    if (redisClient.status !== 'ready') {
        console.warn('Redis is down, unable to remove group cycle immediately.');
        return;
    }
    
    const queue = getQueue();
    const cron = getCronPattern(frequency);
    const jobId = `cycle-start:${groupId}`;
    
    await queue.removeRepeatable('cycle-start', {
        pattern: cron,
        jobId,
    });
}

export async function enqueueDelayedReminder(groupId: string, delayMs: number): Promise<Job | null> {
    if (redisClient.status !== 'ready') {
        return null;
    }
    
    const queue = getQueue();
    return await queue.add(
        'last-call-reminder',
        { groupId },
        {
            delay: Math.max(0, delayMs),
            jobId: `reminder:${groupId}:${Date.now()}`
        }
    );
}

export async function enqueueCycleEnd(groupId: string, delayMs: number): Promise<Job | null> {
    if (redisClient.status !== 'ready') {
        return null;
    }
    
    const queue = getQueue();
    return await queue.add(
        'cycle-end',
        { groupId },
        {
            delay: Math.max(0, delayMs),
            jobId: `end:${groupId}:${Date.now()}`
        }
    );
}

export async function closeQueue(): Promise<void> {
    if (queueInstance) {
        await queueInstance.close();
        queueInstance = null;
    }
}
