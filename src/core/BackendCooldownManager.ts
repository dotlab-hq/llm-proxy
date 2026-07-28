const DEFAULT_COOLDOWN_MS = 2_000;   // Reduced from 5s to 2s for faster recovery
const AUTH_FAIL_COOLDOWN_MS = 30_000;  // Reduced from 60s to 30s
const HEALTHY_THRESHOLD_MS = 300_000;  // 5min — forget provider-level cooldown after this

export function isRetryableUpstreamStatus( status: number ): boolean {
    return status === 401 || status === 429 || ( status >= 500 && status <= 599 );
}

/**
 * Enhanced cooldown manager that tracks cooldowns at both the
 * provider+model level and the provider level. When a provider
 * experiences repeated failures across *different* models, the
 * provider-level cooldown kicks in to skip ALL models from that
 * provider for a period.
 */
export class BackendCooldownManager {
    private readonly blockedUntilByKey = new Map<string, number>();
    private readonly providerFailureCounts = new Map<string, { count: number; lastFailure: number }>();
    private readonly providerBlockedUntil = new Map<string, number>();

    constructor( private readonly defaultCooldownMs: number = DEFAULT_COOLDOWN_MS ) { }

    markFromStatus( providerId: string, modelName: string, status: number, cooldownMs?: number ): boolean {
        if ( !isRetryableUpstreamStatus( status ) ) {
            // Non-retryable status — clear provider-level failure tracking
            this.providerFailureCounts.delete( providerId );
            return false;
        }
        const effective = cooldownMs ?? ( status === 401 ? AUTH_FAIL_COOLDOWN_MS : this.defaultCooldownMs );
        this.markCooldown( providerId, modelName, effective );

        // Track provider-level failures for cascading cooldown
        const providerRecord = this.providerFailureCounts.get( providerId ) ?? { count: 0, lastFailure: Date.now() };
        providerRecord.count += 1;
        providerRecord.lastFailure = Date.now();
        this.providerFailureCounts.set( providerId, providerRecord );

        // If this provider has failed across 3+ distinct model attempts recently,
        // trigger a provider-level cooldown to skip ALL its models temporarily.
        if ( providerRecord.count >= 3 ) {
            const backoffMs = Math.min( 15_000, providerRecord.count * 3_000 ); // 9s, 12s, 15s...
            this.providerBlockedUntil.set( providerId, Date.now() + backoffMs );
            console.warn( `[cooldown] provider_level_cooldown provider=${providerId} failures=${providerRecord.count} backoffMs=${backoffMs}` );
        }

        return true;
    }

    markCooldown( providerId: string, modelName: string, cooldownMs: number = this.defaultCooldownMs ): number {
        const key = this.buildKey( providerId, modelName );
        const existing = this.blockedUntilByKey.get( key );
        const blockedUntil = Date.now() + cooldownMs;

        if ( typeof existing === 'number' && existing > blockedUntil ) {
            return existing;
        }

        this.blockedUntilByKey.set( key, blockedUntil );
        return blockedUntil;
    }

    isOnCooldown( providerId: string, modelName: string ): boolean {
        return this.getRemainingMs( providerId, modelName ) > 0;
    }

    /**
     * Returns remaining cooldown ms for a provider+model pair.
     * Also checks provider-level cooldown — if the entire provider is
     * blocked, returns that value (which is higher).
     */
    getRemainingMs( providerId: string, modelName: string ): number {
        // First check provider-level cooldown
        const providerBlockedUntil = this.providerBlockedUntil.get( providerId );
        if ( typeof providerBlockedUntil === 'number' ) {
            const providerRemaining = providerBlockedUntil - Date.now();
            if ( providerRemaining > 0 ) return providerRemaining;
            this.providerBlockedUntil.delete( providerId );
            // Clean up failure counts after cooldown expires
            const record = this.providerFailureCounts.get( providerId );
            if ( record && Date.now() - record.lastFailure > HEALTHY_THRESHOLD_MS ) {
                this.providerFailureCounts.delete( providerId );
            }
        }

        // Then check model-level cooldown
        const key = this.buildKey( providerId, modelName );
        const blockedUntil = this.blockedUntilByKey.get( key );

        if ( typeof blockedUntil !== 'number' ) {
            return 0;
        }

        const remainingMs = blockedUntil - Date.now();
        if ( remainingMs <= 0 ) {
            this.blockedUntilByKey.delete( key );
            return 0;
        }

        return remainingMs;
    }

    /**
     * Returns a health score (0-100) for a provider, based on recent failure patterns.
     * 100 = perfectly healthy, 0 = completely degraded.
     */
    getProviderHealthScore( providerId: string ): number {
        const record = this.providerFailureCounts.get( providerId );
        if ( !record ) return 100;
        if ( Date.now() - record.lastFailure > HEALTHY_THRESHOLD_MS ) {
            this.providerFailureCounts.delete( providerId );
            return 100;
        }
        return Math.max( 0, 100 - record.count * 20 );
    }

    /**
     * Clears provider-level cooldown after a successful request.
     * Call this when a request to this provider succeeds.
     */
    recordSuccess( providerId: string ): void {
        this.providerFailureCounts.delete( providerId );
        this.providerBlockedUntil.delete( providerId );
    }

    private buildKey( providerId: string, modelName: string ): string {
        return `${providerId}::${modelName}`;
    }
}

export const backendCooldownManager = new BackendCooldownManager();
