import Redis from 'ioredis';
import { config } from '../config/env';

// Initialize Redis client using the existing configuration
const options: any = { enableOfflineQueue: false, maxRetriesPerRequest: null };
if (process.env.NODE_ENV === 'test') {
    options.lazyConnect = true;
}
export const redisClient = new Redis(config.REDIS_URL, options);

redisClient.on('error', (err) => {
    console.error('Redis client error:', err);
});
