import { redisClient } from '../lib/redis';
import { WhatsAppService } from './whatsapp.service';

const whatsappService = new WhatsAppService();

export interface CommandHistoryEntry {
    command: string;
    timestamp: number;
}

export class AbuseDetectionService {
    private inMemoryHits = new Map<string, number[]>();
    private inMemoryFlags = new Map<string, string>();
    private inMemoryHistory = new Map<string, CommandHistoryEntry[]>();
    
    // For test simulation of Redis failure
    private forceRedisFailure = false;
    
    public setForceRedisFailure(val: boolean) {
        this.forceRedisFailure = val;
    }
    
    private isRedisAvailable(): boolean {
        if (this.forceRedisFailure) {
            return false;
        }
        // ioredis client is connected if status is 'ready' or 'connect'
        // If not connected or in error, we fall back.
        return redisClient.status === 'ready' || redisClient.status === 'connect';
    }
    
    public async recordCommand(phoneNumber: string, commandText: string): Promise<void> {
        const now = Date.now();
        const entry: CommandHistoryEntry = { command: commandText, timestamp: now };
        
        if (this.isRedisAvailable()) {
            try {
                const key = `command_history:${phoneNumber}`;
                await redisClient.lpush(key, JSON.stringify(entry));
                await redisClient.ltrim(key, 0, 19); // Keep last 20 commands
                await redisClient.expire(key, 24 * 60 * 60); // 24 hours
                return;
            } catch (err) {
                console.warn('Redis error in recordCommand, falling back to in-memory:', err);
            }
        }
        
        // In-memory fallback
        const history = this.inMemoryHistory.get(phoneNumber) || [];
        history.unshift(entry);
        if (history.length > 20) {
            history.length = 20;
        }
        this.inMemoryHistory.set(phoneNumber, history);
    }
    
    public async getCommandHistory(phoneNumber: string): Promise<CommandHistoryEntry[]> {
        if (this.isRedisAvailable()) {
            try {
                const key = `command_history:${phoneNumber}`;
                const rawList = await redisClient.lrange(key, 0, -1);
                return rawList.map(item => JSON.parse(item));
            } catch (err) {
                console.warn('Redis error in getCommandHistory, falling back to in-memory:', err);
            }
        }
        
        return this.inMemoryHistory.get(phoneNumber) || [];
    }
    
    public async recordFinancialLimitHit(phoneNumber: string, commandText: string): Promise<boolean> {
        const now = Date.now();
        const tenMinutesMs = 10 * 60 * 1000;
        
        // Always record this hit in command history too
        await this.recordCommand(phoneNumber, `[RATE LIMIT HIT] ${commandText}`);
        
        let flagged = false;
        let hitsCount = 0;
        
        if (this.isRedisAvailable()) {
            try {
                const hitsKey = `abuse_hits:${phoneNumber}`;
                const uniqueVal = `${now}-${Math.random()}`;
                
                await redisClient.zadd(hitsKey, now, uniqueVal);
                await redisClient.zremrangebyscore(hitsKey, '-inf', now - tenMinutesMs);
                hitsCount = await redisClient.zcard(hitsKey);
                await redisClient.expire(hitsKey, 600); // 10 minutes TTL
                
                if (hitsCount >= 3) {
                    flagged = true;
                }
            } catch (err) {
                console.warn('Redis error in recordFinancialLimitHit, falling back to in-memory:', err);
                flagged = false;
            }
        }
        
        // Fallback or run in-memory if Redis failed / was unavailable
        if (!this.isRedisAvailable()) {
            const hits = this.inMemoryHits.get(phoneNumber) || [];
            hits.push(now);
            // Filter hits within last 10 minutes
            const recentHits = hits.filter(t => t > now - tenMinutesMs);
            this.inMemoryHits.set(phoneNumber, recentHits);
            hitsCount = recentHits.length;
            
            if (hitsCount >= 3) {
                flagged = true;
            }
        }
        
        if (flagged) {
            await this.flagUserForReview(phoneNumber);
            return true;
        }
        
        return false;
    }
    
    private async flagUserForReview(phoneNumber: string): Promise<void> {
        const now = Date.now();
        const history = await this.getCommandHistory(phoneNumber);
        const logData = {
            phoneNumber,
            flaggedAt: new Date(now).toISOString(),
            commandHistory: history
        };
        
        console.warn(`[ABUSE DETECTION] User flagged for review:`, JSON.stringify(logData, null, 2));
        
        // Send WhatsApp admin notification if ADMIN_PHONE_NUMBER is configured
        const adminPhone = process.env.ADMIN_PHONE_NUMBER;
        if (adminPhone) {
            try {
                await whatsappService.sendMessage(
                    adminPhone,
                    `⚠️ [ABUSE DETECTED] User ${phoneNumber} has been flagged for review. Hit financial rate limit 3 times in 10 minutes.`
                );
            } catch (err) {
                console.error('Failed to send admin WhatsApp notification:', err);
            }
        }
        
        // Store flag in Redis with a 24-hour TTL
        if (this.isRedisAvailable()) {
            try {
                const flagKey = `abuse_flag:${phoneNumber}`;
                await redisClient.set(flagKey, JSON.stringify(logData), 'EX', 24 * 60 * 60);
                return;
            } catch (err) {
                console.warn('Redis error in flagUserForReview, falling back to in-memory:', err);
            }
        }
        
        this.inMemoryFlags.set(phoneNumber, JSON.stringify(logData));
    }
    
    public async isUserFlagged(phoneNumber: string): Promise<boolean> {
        if (this.isRedisAvailable()) {
            try {
                const flagKey = `abuse_flag:${phoneNumber}`;
                const exists = await redisClient.exists(flagKey);
                return exists === 1;
            } catch (err) {
                console.warn('Redis error in isUserFlagged, falling back to in-memory:', err);
            }
        }
        
        return this.inMemoryFlags.has(phoneNumber);
    }

    public clearInMemory(): void {
        this.inMemoryHits.clear();
        this.inMemoryFlags.clear();
        this.inMemoryHistory.clear();
    }
}

export const abuseDetectionService = new AbuseDetectionService();
