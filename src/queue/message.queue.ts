import { Queue, Job } from 'bullmq';
import { config } from '../config/env';
import crypto from 'crypto';

export interface MessageJobData {
    from: string;
    msgBody: string;
    messageTimestamp: number;
}

const connection = {
    url: config.REDIS_URL,
};

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
        queueInstance = new Queue('message-processing', {
            connection,
            defaultJobOptions,
        });
    }
    return queueInstance;
}

export async function enqueueMessage(data: MessageJobData): Promise<Job> {
    const queue = getQueue();
    const jobId = crypto
        .createHash('sha256')
        .update(`${data.from}:${data.msgBody}:${data.messageTimestamp}`)
        .digest('hex');

    return await queue.add('process-message', data, {
        jobId,
    });
}

export async function closeQueue(): Promise<void> {
    if (queueInstance) {
        await queueInstance.close();
        queueInstance = null;
    }
}
