import { CACHE } from "../state";
import type { Config } from "@/schema";

type RateLimit = Config['models']['openai'][0]['rateLimit'];

interface UsageRecord {
    tokensUsed: number;
    requestsUsed: number;
    minuteStart: number;
    dayStart: number;
    dailyTokens: number;
    dailyRequests: number;
}

export class RateLimitManager {
    private readonly keyPrefix = 'rate_limit:';
    private readonly avgTokensPerRequest = 1000;

    async checkAndConsume(
        modelId: string, 
        tokens: number, 
        rateLimit: RateLimit
    ): Promise<{ allowed: boolean; reason?: string }> {
        const key = `${this.keyPrefix}${modelId}`;
        const now = Date.now();
        const oneMinute = 60 * 1000;
        const oneDay = 24 * 60 * 60 * 1000;
        
        const record = await this.getOrCreateRecord(key, now);
        
        if (now - record.minuteStart > oneMinute) {
            record.tokensUsed = 0;
            record.requestsUsed = 0;
            record.minuteStart = now;
        }
        
        const currentDayStart = Math.floor(now / oneDay) * oneDay;
        if (record.dayStart !== currentDayStart) {
            record.dailyTokens = 0;
            record.dailyRequests = 0;
            record.dayStart = currentDayStart;
        }
        
        const dailyTokenLimit = rateLimit.requestsPerDay * this.avgTokensPerRequest;
        
        if (record.tokensUsed + tokens > rateLimit.tokensPerMinute) {
            return { allowed: false, reason: 'Token rate limit exceeded' };
        }
        
        if (record.requestsUsed + 1 > rateLimit.requestsPerMinute) {
            return { allowed: false, reason: 'Request rate limit exceeded' };
        }
        
        if (record.dailyTokens + tokens > dailyTokenLimit) {
            return { allowed: false, reason: 'Daily token limit exceeded' };
        }
        
        if (record.dailyRequests + 1 > rateLimit.requestsPerDay) {
            return { allowed: false, reason: 'Daily request limit exceeded' };
        }
        
        record.tokensUsed += tokens;
        record.requestsUsed += 1;
        record.dailyTokens += tokens;
        record.dailyRequests += 1;
        
        await CACHE.setKey(key, record);
        return { allowed: true };
    }
    
    async getUsage(modelId: string): Promise<UsageRecord | null> {
        const key = `${this.keyPrefix}${modelId}`;
        return await CACHE.getKey<UsageRecord>(key) ?? null;
    }
    
    async reset(modelId: string): Promise<void> {
        const key = `${this.keyPrefix}${modelId}`;
        await CACHE.setKey(key, this.emptyRecord());
    }
    
    private async getOrCreateRecord(key: string, now: number): Promise<UsageRecord> {
        let record = await CACHE.getKey<UsageRecord>(key);
        if (!record) {
            record = this.emptyRecord(now);
        }
        return record;
    }
    
    private emptyRecord(now: number = Date.now()): UsageRecord {
        const oneDay = 24 * 60 * 60 * 1000;
        return {
            tokensUsed: 0,
            requestsUsed: 0,
            minuteStart: now,
            dayStart: Math.floor(now / oneDay) * oneDay,
            dailyTokens: 0,
            dailyRequests: 0
        };
    }
}

export const rateLimitManager = new RateLimitManager();