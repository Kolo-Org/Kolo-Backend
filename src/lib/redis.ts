import Redis from 'ioredis';
import { config } from '../config/env';

// Initialize Redis client using the existing configuration
export const redisClient = new Redis(config.REDIS_URL);

redisClient.on('error', (err) => {
    console.error('Redis client error:', err);
});
