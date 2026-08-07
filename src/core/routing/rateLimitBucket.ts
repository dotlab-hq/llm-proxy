import { CACHE } from "../../state";
import type { BucketRecord, RateLimit } from './rateLimitTypes';

export const ONE_DAY_MS = 24 * 60 * 60 * 1000;
export const ONE_HOUR_MS = 60 * 60 * 1000;

export function computeDayStart( now: number ): number {
    return Math.floor( now / ONE_DAY_MS ) * ONE_DAY_MS;
}

export function computeHourStart( now: number ): number {
    return Math.floor( now / ONE_HOUR_MS ) * ONE_HOUR_MS;
}

export function calculateInitialTokens( rateLimit: RateLimit | undefined ): number {
    if ( rateLimit ) {
        if ( typeof rateLimit.tokensPerMinute === 'number' ) {
            return rateLimit.tokensPerMinute;
        }
        if ( typeof rateLimit.requestsPerMinute === 'number' ) {
            return rateLimit.requestsPerMinute;
        }
    }
    return 1000;
}

export function createBucket( rateLimit: RateLimit | undefined ): BucketRecord {
    const now = Date.now();
    return {
        tokens: calculateInitialTokens( rateLimit ),
        lastRefill: now,
        dailyRequests: 0,
        dayStart: computeDayStart( now ),
        audioSecondsThisHour: 0,
        hourStart: computeHourStart( now ),
        audioSecondsToday: 0,
        audioDayStart: computeDayStart( now ),
        tokensToday: 0,
        tokenDayStart: computeDayStart( now ),
    };
}

export function emptyBucket(): BucketRecord {
    const now = Date.now();
    return {
        tokens: 0,
        lastRefill: now,
        dailyRequests: 0,
        dayStart: computeDayStart( now ),
        audioSecondsThisHour: 0,
        hourStart: computeHourStart( now ),
        audioSecondsToday: 0,
        audioDayStart: computeDayStart( now ),
        tokensToday: 0,
        tokenDayStart: computeDayStart( now ),
    };
}

export function resetDayCounters( record: BucketRecord, now: number ): void {
    const dayStart = computeDayStart( now );
    record.dailyRequests = 0;
    record.dayStart = dayStart;
    record.audioSecondsToday = 0;
    record.audioDayStart = dayStart;
}

export function resetHourCounters( record: BucketRecord, now: number ): void {
    record.audioSecondsThisHour = 0;
    record.hourStart = computeHourStart( now );
}

export interface LockEntry {
    promise: Promise<void>;
    resolve: () => void;
    expires: number;
}

export type LockMap = Map<string, LockEntry>;

export function getBucketUsage(
    key: string
): Promise<{ tokensRemaining: number; dailyRequests: number; audioSecondsThisHour: number; audioSecondsToday: number; tokensToday: number } | null> {
    return CACHE.getKey<BucketRecord>( key ).then( record => record ? {
        tokensRemaining: Math.ceil( record.tokens ),
        dailyRequests: record.dailyRequests,
        audioSecondsThisHour: record.audioSecondsThisHour,
        audioSecondsToday: record.audioSecondsToday,
        tokensToday: record.tokensToday
    } : null );
}

/**
 * Refill-aware meter peek (read-only, no consumption). Used for preemptive
 * TPM hopping: estimates the tokens available RIGHT NOW by applying the same
 * token-bucket refill math as checkAndConsume, without mutating the record.
 * Returns null when no bucket exists yet (nothing configured/consumed yet →
 * caller should treat it as unlimited and proceed).
 */
export function peekRemaining( key: string, rateLimit: RateLimit | undefined ): Promise<number | null> {
    if ( !rateLimit ) return Promise.resolve( null );
    const hasTokensPerMinute = typeof rateLimit.tokensPerMinute === 'number';
    const hasRequestsPerMinute = typeof rateLimit.requestsPerMinute === 'number';
    const tokenLimit = hasTokensPerMinute
        ? ( rateLimit.tokensPerMinute as number )
        : ( hasRequestsPerMinute ? ( rateLimit.requestsPerMinute as number ) : 0 );
    if ( tokenLimit <= 0 ) return Promise.resolve( null );
    return CACHE.getKey<BucketRecord>( key ).then( record => {
        if ( !record ) return null;
        const now = Date.now();
        const tokensPerSecond = tokenLimit / 60;
        const refillAmount = ( now - record.lastRefill ) / 1000 * tokensPerSecond;
        return Math.ceil( Math.min( tokenLimit, record.tokens + refillAmount ) );
    } );
}

export function resetBucket( key: string ): Promise<void> {
    return CACHE.setKey( key, emptyBucket() );
}

export async function getOrCreateBucket( key: string, rateLimit?: RateLimit ): Promise<BucketRecord> {
    const record = await CACHE.getKey<BucketRecord>( key );
    if ( !record ) {
        return createBucket( rateLimit );
    }
    return record;
}

export async function checkAndConsumeTTS(
    key: string,
    locks: LockMap,
    characters: number,
    rateLimit: RateLimit
): Promise<{ allowed: boolean; reason?: string }> {
    const release = await acquireLock( locks, key );
    try {
        const record = await getOrCreateBucket( key, rateLimit );
        const now = Date.now();

        // Reset daily token counter if needed
        const currentDayStart = Math.floor( now / ONE_DAY_MS ) * ONE_DAY_MS;
        if ( record.tokenDayStart !== currentDayStart ) {
            record.tokensToday = 0;
            record.tokenDayStart = currentDayStart;
        }

        // Check per-day token limit
        if ( record.tokensToday + characters > ( rateLimit.tokensPerDay as number ) ) {
            return { allowed: false, reason: 'Daily TTS token limit exceeded' };
        }

        // All checks passed — consume
        record.tokensToday += characters;

        await CACHE.setKey( key, record );
        return { allowed: true };
    } finally {
        release();
    }
}

export const LOCK_TIMEOUT_MS = 5000; // 5 second timeout for locks

export function cleanupExpiredLocks( locks: LockMap ): void {
    const now = Date.now();
    for ( const [key, lock] of locks.entries() ) {
        if ( now > lock.expires ) {
            locks.delete( key );
            // Resolve the promise to prevent waiting forever
            lock.resolve();
        }
    }
}

function timeoutPromise( ms: number ): Promise<never> {
    return new Promise( ( _, reject ) => {
        setTimeout( () => reject( new Error( 'Lock timeout' ) ), ms );
    } );
}

export async function acquireLock( locks: LockMap, lockKey: string ): Promise<() => void> {
    // Clean up expired locks first
    cleanupExpiredLocks( locks );

    while ( true ) {
        const existing = locks.get( lockKey );
        if ( !existing ) {
            // No lock exists, try to create one
            let resolveFn: () => void;
            const promise = new Promise<void>( resolve => { resolveFn = resolve; } );
            const expires = Date.now() + LOCK_TIMEOUT_MS;

            // Use a map operation that is atomic for checking and setting
            if ( !locks.has( lockKey ) ) {
                locks.set( lockKey, { promise, resolve: resolveFn!, expires } );

                return () => {
                    resolveFn!();
                    locks.delete( lockKey );
                };
            }
            // If we get here, another process created the lock while we were setting up
            // Continue the loop to wait for it
            continue;
        }

        // Lock exists, wait for it to be released or timeout
        try {
            await Promise.race( [
                existing.promise,
                timeoutPromise( existing.expires - Date.now() )
            ] );
            // After waiting, clean up expired locks again and retry
            cleanupExpiredLocks( locks );
        } catch ( err ) {
            // Timeout occurred, remove the expired lock and retry
            locks.delete( lockKey );
            cleanupExpiredLocks( locks );
        }
    }
}
