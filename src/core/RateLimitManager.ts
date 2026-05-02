import { CACHE } from "../state";
import type { Config } from "@/schema";

type RateLimit = NonNullable<Config['rateLimit']>;

interface BucketRecord {
    tokens: number;
    lastRefill: number;
    dailyRequests: number;
    dayStart: number;
}

export class RateLimitManager {
    private readonly keyPrefix = 'rate_limit:';
    private readonly locks = new Map<string, { promise: Promise<void>; resolve: () => void }>();

    async checkAndConsume(
        modelId: string,
        tokens: number,
        rateLimit: RateLimit | undefined
    ): Promise<{ allowed: boolean; reason?: string }> {
        if (!rateLimit) {
            return { allowed: true };
        }
        
        const key = `${this.keyPrefix}${modelId}`;

        const release = await this.acquireLock(key);

        try {
            const record = await this.getOrCreateBucket(key);
            const now = Date.now();
            const oneDay = 24 * 60 * 60 * 1000;

            const currentDayStart = Math.floor(now / oneDay) * oneDay;
            if (record.dayStart !== currentDayStart) {
                record.dailyRequests = 0;
                record.dayStart = currentDayStart;
            }

            if (record.dailyRequests + 1 > rateLimit.requestsPerDay) {
                return { allowed: false, reason: 'Daily request limit exceeded' };
            }

            const tokensPerSecond = rateLimit.requestsPerMinute / 60;
            const refillAmount = (now - record.lastRefill) / 1000 * tokensPerSecond;
            record.tokens = Math.min(rateLimit.requestsPerMinute, record.tokens + refillAmount);
            record.lastRefill = now;

            if (record.tokens >= 1) {
                record.tokens -= 1;
                record.dailyRequests += 1;
                await CACHE.setKey(key, record);
                return { allowed: true };
            }

            return { allowed: false, reason: 'Rate limit exceeded' };
        } finally {
            release();
        }
    }

    private async acquireLock(lockKey: string): Promise<() => void> {
        while (this.locks.has(lockKey)) {
            const existing = this.locks.get(lockKey)!;
            await existing.promise;
        }

        let resolveFn: () => void;
        const promise = new Promise<void>(resolve => { resolveFn = resolve; });
        this.locks.set(lockKey, { promise, resolve: resolveFn! });

        return () => {
            resolveFn!();
            this.locks.delete(lockKey);
        };
    }

    private async getOrCreateBucket(key: string): Promise<BucketRecord> {
        const record = await CACHE.getKey<BucketRecord>(key);
        if (!record) {
            const now = Date.now();
            const oneDay = 24 * 60 * 60 * 1000;
            const newRecord = {
                tokens: 150,
                lastRefill: now,
                dailyRequests: 0,
                dayStart: Math.floor(now / oneDay) * oneDay
            };
            await CACHE.setKey(key, newRecord);
            return newRecord;
        }
        return record;
    }

    async getUsage(modelId: string): Promise<{ requestsUsed: number; dailyRequests: number } | null> {
        const key = `${this.keyPrefix}${modelId}`;
        const record = await CACHE.getKey<BucketRecord>(key);
        return record ? {
            requestsUsed: Math.ceil(record.tokens),
            dailyRequests: record.dailyRequests
        } : null;
    }

    async reset(modelId: string): Promise<void> {
        const key = `${this.keyPrefix}${modelId}`;
        await CACHE.setKey(key, this.emptyBucket());
    }

    private emptyBucket(): BucketRecord {
        const now = Date.now();
        const oneDay = 24 * 60 * 60 * 1000;
        return {
            tokens: 0,
            lastRefill: now,
            dailyRequests: 0,
            dayStart: Math.floor(now / oneDay) * oneDay
        };
    }
}

export const rateLimitManager = new RateLimitManager();