import { Worker } from 'bullmq';
import { config } from '../config/env';
import { MessageProcessor } from '../services/message-processor.service';
import { WhatsAppService } from '../services/whatsapp.service';
import { StellarService } from '../services/stellar.service';
import { UserService } from '../services/user.service';
import { GroupService } from '../services/group.service';

const connection = {
    url: config.REDIS_URL,
};

let workerInstance: Worker | null = null;

export function startWorker(): void {
    if (workerInstance) return;

    const processor = new MessageProcessor(
        new WhatsAppService(),
        new StellarService(),
        new UserService(),
        new GroupService(),
    );

    workerInstance = new Worker(
        'message-processing',
        async (job) => {
            const { from, msgBody } = job.data;
            console.log(`Processing job ${job.id}: message from ${from}`);
            await processor.processCommand(from, msgBody);
        },
        {
            connection,
            concurrency: 5,
        }
    );

    workerInstance.on('completed', (job) => {
        console.log(`Job ${job.id} completed`);
    });

    workerInstance.on('failed', (job, err) => {
        console.error(`Job ${job?.id} failed after ${job?.attemptsMade} attempts:`, err);
    });

    console.log('Message worker started');
}

export async function closeWorker(): Promise<void> {
    if (workerInstance) {
        await workerInstance.close();
        workerInstance = null;
    }
}
