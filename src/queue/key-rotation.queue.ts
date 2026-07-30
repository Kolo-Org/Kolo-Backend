import { Queue } from 'bullmq';
import { redisClient } from '../lib/redis';
import { keyRotationQueueName } from '../workers/key-rotation.worker';

export const keyRotationQueue = new Queue(keyRotationQueueName, {
    connection: redisClient as any
});
