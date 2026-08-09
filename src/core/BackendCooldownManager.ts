const DEFAULT_COOLDOWN_MS = 2_000;   // Reduced from 5s to 2s for faster recovery
const AUTH_FAIL_COOLDOWN_MS = 30_000;  // Reduced from 60s to 30s
const HEALTHY_THRESHOLD_MS = 300_000;  // 5min — forget provider-level cooldown after this
const MODEL_BACKOFF_CAP_MS = 30_000;   // Max model-level cooldown
const MODEL_BACKOFF_BASE_MS = 2_000;   // Starting model cooldown

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
    private readonly modelFailureCounts = new Map<string, { count: number; lastFailure: number }>();

    constructor( private readonly defaultCooldownMs: number = DEFAULT_COOLDOWN_MS ) { }

    markFromStatus( providerId: string, modelName: string, status: number, cooldownMs?: number ): boolean {
        if ( !isRetryableUpstreamStatus( status ) ) {
            // Non-retryable status — clear provider-level failure tracking
            this.providerFailureCounts.delete( providerId );
            return false;
        }
        const effective = cooldownMs ?? ( status === 401 ? AUTH_FAIL_COOLDOWN_MS : this.defaultCooldownMs );
        this.markCooldown( providerId, modelName, effective );

        // Track model-level failures for escalating cooldown
        const modelKey = this.buildKey( providerId, modelName );
        const modelRecord = this.modelFailureCounts.get( modelKey ) ?? { count: 0, lastFailure: Date.now() };
        modelRecord.count += 1;
        modelRecord.lastFailure = Date.now();
        this.modelFailureCounts.set( modelKey, modelRecord );

        // Escalating model cooldown: 2s, 4s, 6s, 8s... capped at 30s
        const modelBackoffMs = Math.min( MODEL_BACKOFF_CAP_MS, modelRecord.count * MODEL_BACKOFF_BASE_MS );
        this.markCooldown( providerId, modelName, modelBackoffMs );

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
     * Model-level cooldown ONLY — skips the provider-level check. Used by the
     * sibling-substitution pass: when a whole provider is in provider-level
     * cooldown, hopping to a *different* model is still worth one probe. The
     * provider cooldown was earned by repeated failures of specific models,
     * and the sibling pass is the last-resort recovery path — a single probe
     * of a fresh model costs nothing compared to dropping the request.
     */
    getModelRemainingMs( providerId: string, modelName: string ): number {
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
     * Decays provider-level failure state after a successful request.
     * Instead of full clear, reduces failure count by half so flaky providers
     * don't get an instant clean slate (they'd need 3+ fresh failures to re-trigger).
     */
    recordSuccess( providerId: string ): void {
        this.providerBlockedUntil.delete( providerId );
        const record = this.providerFailureCounts.get( providerId );
        if ( record ) {
            record.count = Math.max( 0, Math.floor( record.count / 2 ) );
            if ( record.count === 0 ) {
                this.providerFailureCounts.delete( providerId );
            }
        }
    }

    /**
     * Returns the model-level failure count for scoring adjustments.
     */
    getModelFailureCount( providerId: string, modelName: string ): number {
        const modelKey = this.buildKey( providerId, modelName );
        const record = this.modelFailureCounts.get( modelKey );
        if ( !record ) return 0;
        // Decay stale records
        if ( Date.now() - record.lastFailure > HEALTHY_THRESHOLD_MS ) {
            this.modelFailureCounts.delete( modelKey );
            return 0;
        }
        return record.count;
    }

    private buildKey( providerId: string, modelName: string ): string {
        return `${providerId}::${modelName}`;
    }
}

export const backendCooldownManager = new BackendCooldownManager();
