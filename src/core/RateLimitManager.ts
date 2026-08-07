import { CACHE } from "../state";
import type { Config } from "@/schema";

import type { BucketRecord, RateLimit } from "./routing/rateLimitTypes";
import {
    acquireLock,
    checkAndConsumeTTS,
    getBucketUsage,
    getOrCreateBucket,
    LOCK_TIMEOUT_MS,
    ONE_DAY_MS,
    ONE_HOUR_MS,
    peekRemaining,
    resetBucket,
    resetDayCounters,
    resetHourCounters,
    type LockMap,
} from "./routing/rateLimitBucket";

export type { BucketRecord, RateLimit } from "./routing/rateLimitTypes";

export class RateLimitManager {
    private readonly keyPrefix = 'rate_limit:';
    private readonly locks: LockMap = new Map();
    private static readonly LOCK_TIMEOUT_MS = LOCK_TIMEOUT_MS; // 5 second timeout for locks

    async checkAndConsume(
        providerId: string,
        tokens: number,
        rateLimit: RateLimit | undefined,
        modelName?: string
    ): Promise<{ allowed: boolean; reason?: string }> {
        // No rateLimit object at all => unlimited
        if ( !rateLimit ) {
            return { allowed: true };
        }

        const hasTokensPerMinute = typeof rateLimit.tokensPerMinute === 'number';
        const hasRequestsPerMinute = typeof rateLimit.requestsPerMinute === 'number';
        const hasRequestsPerDay = typeof rateLimit.requestsPerDay === 'number';
        const hasTokensPerDay = typeof rateLimit.tokensPerDay === 'number';

        // If no limits specified, treat as unlimited
        if ( !hasTokensPerMinute && !hasRequestsPerMinute && !hasRequestsPerDay && !hasTokensPerDay ) {
            return { allowed: true };
        }

        const key = modelName ? `${this.keyPrefix}${providerId}:${modelName}` : `${this.keyPrefix}${providerId}`;

        const release = await acquireLock( this.locks, key );

        try {
            const record = await getOrCreateBucket( key, rateLimit );
            const now = Date.now();

            const currentDayStart = Math.floor( now / ONE_DAY_MS ) * ONE_DAY_MS;
            if ( record.dayStart !== currentDayStart ) {
                record.dailyRequests = 0;
                record.dayStart = currentDayStart;
            }

            // Enforce daily limit only if provided
            if ( hasRequestsPerDay && ( record.dailyRequests + 1 > ( rateLimit.requestsPerDay as number ) ) ) {
                return { allowed: false, reason: 'Daily request limit exceeded' };
            }

            // Enforce daily token limit only if provided
            if ( hasTokensPerDay && ( record.tokensToday + tokens > ( rateLimit.tokensPerDay as number ) ) ) {
                return { allowed: false, reason: 'Daily token limit exceeded' };
            }

            // Token-bucket algorithm using tokensPerMinute if available, otherwise requestsPerMinute
            const tokenLimit: number = hasTokensPerMinute
                ? ( rateLimit.tokensPerMinute as number )
                : ( hasRequestsPerMinute ? ( rateLimit.requestsPerMinute as number ) : 0 );

            if ( tokenLimit > 0 ) {
                const tokensPerSecond = tokenLimit / 60;
                const refillAmount = ( now - record.lastRefill ) / 1000 * tokensPerSecond;
                record.tokens = Math.min( tokenLimit, record.tokens + refillAmount );
                record.lastRefill = now;

                if ( record.tokens >= tokens ) {
                    record.tokens -= tokens;
                    if ( hasRequestsPerDay ) record.dailyRequests += 1;
                    record.tokensToday += tokens;
                    await CACHE.setKey( key, record );
                    return { allowed: true };
                }

                return { allowed: false, reason: 'Rate limit exceeded' };
            }

            // No token-based limit, just track daily
            if ( hasRequestsPerDay ) {
                record.dailyRequests += 1;
            }
            record.tokensToday += tokens;
            await CACHE.setKey( key, record );
            return { allowed: true };
        } finally {
            release();
        }
    }

    /**
     * Check and consume audio seconds for STT providers.
     * @param providerId - The provider identifier
     * @param audioSeconds - Number of seconds of audio to transcribe
     * @param rateLimit - The unified rate limit configuration (reads audioSecondsPerHour/audioSecondsPerDay)
     * @param modelName - Optional model name for per-model tracking
     */
    async checkAndConsumeAudioSeconds(
        providerId: string,
        audioSeconds: number,
        rateLimit: RateLimit | undefined,
        modelName?: string
    ): Promise<{ allowed: boolean; reason?: string }> {
        if ( !rateLimit ) {
            return { allowed: true };
        }

        const hasAudioSecondsPerHour = typeof rateLimit.audioSecondsPerHour === 'number';
        const hasAudioSecondsPerDay = typeof rateLimit.audioSecondsPerDay === 'number';
        const hasRequestsPerMinute = typeof rateLimit.requestsPerMinute === 'number';
        const hasRequestsPerDay = typeof rateLimit.requestsPerDay === 'number';

        if ( !hasAudioSecondsPerHour && !hasAudioSecondsPerDay && !hasRequestsPerMinute && !hasRequestsPerDay ) {
            return { allowed: true };
        }

        const key = `${this.keyPrefix}stt:${providerId}${modelName ? ':' + modelName : ''}`;

        const release = await acquireLock( this.locks, key );

        try {
            const record = await getOrCreateBucket( key );
            const now = Date.now();

            // Reset hourly audio counter if needed
            const currentHourStart = Math.floor( now / ONE_HOUR_MS ) * ONE_HOUR_MS;
            if ( record.hourStart !== currentHourStart ) {
                resetHourCounters( record, now );
            }

            // Reset daily audio counter if needed
            const currentDayStart = Math.floor( now / ONE_DAY_MS ) * ONE_DAY_MS;
            if ( record.audioDayStart !== currentDayStart ) {
                resetDayCounters( record, now );
            }

            // Check daily request limit
            if ( hasRequestsPerDay && ( record.dailyRequests + 1 > ( rateLimit.requestsPerDay as number ) ) ) {
                return { allowed: false, reason: 'Daily STT request limit exceeded' };
            }

            // Check daily audio seconds limit
            if ( hasAudioSecondsPerDay && ( record.audioSecondsToday + audioSeconds > ( rateLimit.audioSecondsPerDay as number ) ) ) {
                return { allowed: false, reason: 'Daily audio seconds limit exceeded' };
            }

            // Check hourly audio seconds limit
            if ( hasAudioSecondsPerHour && ( record.audioSecondsThisHour + audioSeconds > ( rateLimit.audioSecondsPerHour as number ) ) ) {
                return { allowed: false, reason: 'Hourly audio seconds limit exceeded' };
            }

            // Check per-minute request limit (token bucket style)
            if ( hasRequestsPerMinute ) {
                const tokenLimit = rateLimit.requestsPerMinute as number;
                const tokensPerSecond = tokenLimit / 60;
                const refillAmount = ( now - record.lastRefill ) / 1000 * tokensPerSecond;
                record.tokens = Math.min( tokenLimit, record.tokens + refillAmount );
                record.lastRefill = now;

                if ( record.tokens < 1 ) {
                    return { allowed: false, reason: 'STT rate limit exceeded (requests per minute)' };
                }
                record.tokens -= 1;
            }

            // All checks passed — consume
            record.audioSecondsThisHour += audioSeconds;
            record.audioSecondsToday += audioSeconds;
            if ( hasRequestsPerDay ) record.dailyRequests += 1;

            await CACHE.setKey( key, record );
            return { allowed: true };
        } finally {
            release();
        }
    }

    /**
     * Check and consume tokens for TTS providers using tokensPerDay limit.
     * @param providerId - The provider identifier
     * @param characters - Number of characters (treated as tokens for daily limit)
     * @param rateLimit - The unified rate limit configuration (reads tokensPerDay)
     * @param modelName - Optional model name for per-model tracking
     */
    async checkAndConsumeTTSCharacters(
        providerId: string,
        characters: number,
        rateLimit: RateLimit | undefined,
        modelName?: string
    ): Promise<{ allowed: boolean; reason?: string }> {
        if ( !rateLimit || typeof rateLimit.tokensPerDay !== 'number' ) {
            return { allowed: true };
        }

        const key = `${this.keyPrefix}tts:${providerId}${modelName ? ':' + modelName : ''}`;
        return checkAndConsumeTTS( key, this.locks, characters, rateLimit );
    }

    async getUsage( providerId: string, modelName?: string ): Promise<{ tokensRemaining: number; dailyRequests: number; audioSecondsThisHour: number; audioSecondsToday: number; tokensToday: number } | null> {
        const key = modelName ? `${this.keyPrefix}${providerId}:${modelName}` : `${this.keyPrefix}${providerId}`;
        return getBucketUsage( key );
    }

    /**
     * Refill-aware meter peek (no consumption). Used for preemptive TPM
     * hopping: returns the estimated tokens available right now for this
     * (provider, model) bucket, or null when nothing is configured/consumed
     * yet (treat as unlimited).
     */
    async peekRemaining( providerId: string, rateLimit: RateLimit | undefined, modelName?: string ): Promise<number | null> {
        const key = modelName ? `${this.keyPrefix}${providerId}:${modelName}` : `${this.keyPrefix}${providerId}`;
        return peekRemaining( key, rateLimit );
    }

    async reset( providerId: string, modelName?: string ): Promise<void> {
        const key = modelName ? `${this.keyPrefix}${providerId}:${modelName}` : `${this.keyPrefix}${providerId}`;
        return resetBucket( key );
    }
}

export const rateLimitManager = new RateLimitManager();
