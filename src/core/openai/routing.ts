import { stripFreeModifier } from '@/utils/modelIds';
import { CONFIG } from '@/utils/schema.lookup';
import { FAST_MODEL_HINTS } from './types';
import type { BackendState, OpenAIModelConfig } from './types';
import {
    isAutoModel,
    configHasModel,
    isEmbeddingsEnabled,
    isGeminiProvider,
    isImageGenerationEnabled,
    isImageEditingEnabled,
    isImageOnlyConfig,
    isSttEnabled,
    isTtsEnabled,
} from '../routing/shared';
import { backendCooldownManager } from '../BackendCooldownManager';

export {
    isAutoModel,
    configHasModel,
    isEmbeddingsEnabled,
    isGeminiProvider,
    isImageGenerationEnabled,
    isImageEditingEnabled,
    isImageOnlyConfig,
    isSttEnabled,
    isTtsEnabled,
};

const MAX_CACHE_SIZE = 1000;
const BACKEND_CACHE_TTL_MS = 10_000;  // Reduced from 30s for faster recovery when providers change health
const MAX_FALLBACK_BACKENDS = 6;  // Cap the number of backends tried per request to prevent routing loops

export function isSttOrImageOnlyConfig( config: OpenAIModelConfig ): boolean {
    return isSttEnabled( config ) || isTtsEnabled( config ) || isImageOnlyConfig( config );
}

function isTextChatEndpoint( endpoint?: string ): boolean {
    return !endpoint
        || endpoint === 'chat/completions'
        || endpoint === 'completions'
        || endpoint === 'responses';
}

export function getBackendsForModel(
    state: BackendState,
    modelName: string,
    endpoint?: string,
): OpenAIModelConfig[] {
    const cacheKey = `${modelName}|${endpoint ?? ''}`;
    const cached = state.backendRouteCache.get( cacheKey );
    if ( cached ) return cached;

    const configs = CONFIG.models.openai ?? [];
    const explicitlyAuto = isAutoModel( modelName );
    const modelIsListed = configs.some( config => configHasModel( config, modelName ) );
    const isAutoModelFlag = explicitlyAuto || !modelIsListed;

    const exactBackends: OpenAIModelConfig[] = [];
    const fallbackBackends: OpenAIModelConfig[] = [];

    for ( const config of configs ) {
        const matchesRequestedModel = configHasModel( config, modelName );
        const canRouteWithoutModelMatch = ( isAutoModelFlag || config.randomRouting !== false ) && !matchesRequestedModel;

        if ( endpoint === 'embeddings' ) {
            if ( !isEmbeddingsEnabled( config ) ) continue;
        } else if ( endpoint === 'audio/transcriptions' || endpoint === 'audio/translations' ) {
            if ( !isSttEnabled( config ) ) continue;
        } else if ( endpoint === 'audio/speech' ) {
            if ( !isTtsEnabled( config ) ) continue;
        } else if ( endpoint === 'images/generations' ) {
            if ( !isImageGenerationEnabled( config ) ) continue;
        } else if ( endpoint === 'images/edits' ) {
            if ( !isImageEditingEnabled( config ) ) continue;
        } else if ( isTextChatEndpoint( endpoint ) ) {
            // image_generation / image_editing providers must never serve text
            if ( isSttOrImageOnlyConfig( config ) || isEmbeddingsEnabled( config ) ) continue;
        }

        if ( matchesRequestedModel ) {
            exactBackends.push( config );
        } else if ( canRouteWithoutModelMatch ) {
            fallbackBackends.push( config );
        }
    }

    const result = isAutoModelFlag
        ? fallbackBackends
        : modelIsListed ? [...exactBackends, ...fallbackBackends] : fallbackBackends;

    // Deduplicate by baseUrl+apiKey to prevent the routing loop from
    // trying the same physical upstream multiple times in a single request.
    // Without this, multiple API keys for the same provider cause severe
    // delays as the proxy iterates through identical endpoints.
    console.info( `[routing] getBackendsForModel pre-dedup count=${result.length} ids=${result.map( b => b.id ).join( ', ' )}` );
    const deduped = dedupeBackends( result ).slice( 0, MAX_FALLBACK_BACKENDS );
    console.info( `[routing] getBackendsForModel post-dedup count=${deduped.length} ids=${deduped.map( b => b.id ).join( ', ' )}` );

    if ( state.backendRouteCache.size > MAX_CACHE_SIZE ) {
        const firstKey = state.backendRouteCache.keys().next().value;
        if ( firstKey ) state.backendRouteCache.delete( firstKey );
    }
    state.backendRouteCache.set( cacheKey, deduped );
    return deduped;
}

/**
 * Deduplicate backends by their `baseUrl` so that multiple API keys for the
 * same upstream don't all get tried in a single request. When duplicates are
 * found, prefer the one with the most recent successful stats.
 */
function dedupeBackends( backends: OpenAIModelConfig[] ): OpenAIModelConfig[] {
    if ( backends.length <= 1 ) return backends;
    const seen = new Map<string, OpenAIModelConfig>();
    for ( const config of backends ) {
        // Use a composite key: baseUrl + apiKey to keep different API keys as separate backends
        // This allows hedged dispatch to race different zen instances in parallel
        const baseUrl = ( config.baseUrl ?? '' ).replace( /\/+$/, '' ).toLowerCase();
        const apiKey = ( config.apiKey ?? '' ).substring( 0, 12 ); // Use prefix to keep distinct keys separate
        const key = `${baseUrl}::${apiKey}`;
        if ( !key || key === '::' ) {
            const fallbackKey = `id:${config.id}`;
            if ( !seen.has( fallbackKey ) ) seen.set( fallbackKey, config );
            continue;
        }
        const existing = seen.get( key );
        if ( !existing ) {
            seen.set( key, config );
            continue;
        }
        // Same physical endpoint AND same API key — keep first occurrence
    }
    return Array.from( seen.values() );
}

function getAndIncrementRoundRobinIndex( state: BackendState, key: string, total: number ): number {
    if ( total <= 0 ) return 0;

    if ( state.rrIndexByKey.size > MAX_CACHE_SIZE ) {
        const keys = Array.from( state.rrIndexByKey.keys() );
        const randomKey = keys[Math.floor( Math.random() * keys.length )];
        state.rrIndexByKey.delete( randomKey! );
    }

    const current = state.rrIndexByKey.get( key ) ?? 0;
    const index = current % total;
    state.rrIndexByKey.set( key, ( index + 1 ) % total );
    return index;
}

export function getRoundRobinBackends( state: BackendState, modelName: string, backends: OpenAIModelConfig[] ): OpenAIModelConfig[] {
    if ( backends.length <= 1 ) return backends;

    const key = `model:${modelName}`;
    const startIndex = getAndIncrementRoundRobinIndex( state, key, backends.length );
    return [...backends.slice( startIndex ), ...backends.slice( 0, startIndex )];
}

export function getOptimizedBackends(
    state: BackendState,
    modelName: string,
    endpoint: string | undefined,
    backends: OpenAIModelConfig[],
): OpenAIModelConfig[] {
    if ( backends.length <= 1 ) return backends;

    const cacheKey = `${endpoint ?? 'default'}:${modelName}`;
    const cached = state.optimizedBackendCache.get( cacheKey );
    if ( cached && cached.expiresAt > Date.now() ) return cached.backends;

    const rotated = getRoundRobinBackends( state, cacheKey, backends );
    const sorted = rotated.sort( ( left, right ) =>
        scoreProvider( state, right, modelName ) - scoreProvider( state, left, modelName )
    );

    state.optimizedBackendCache.set( cacheKey, {
        backends: sorted,
        expiresAt: Date.now() + BACKEND_CACHE_TTL_MS,
    } );

    if ( state.optimizedBackendCache.size > MAX_CACHE_SIZE ) {
        const firstKey = state.optimizedBackendCache.keys().next().value;
        if ( firstKey ) state.optimizedBackendCache.delete( firstKey );
    }

    return sorted;
}

export function scoreProvider( state: BackendState, config: OpenAIModelConfig, requestedModel: string ): number {
    const candidateModels = getCandidateModelsForProvider( state, config, requestedModel );
    const firstModel = candidateModels[0] ?? requestedModel;
    const stats = state.providerStats.getStats( config.id, firstModel );

    // Exact model match gets top priority
    const exactScore = configHasModel( config, requestedModel ) ? 100 : 0;

    // Success rate — heavily weighted. Providers with low success get pushed down fast.
    const successRate = stats?.successRateEwma ?? 1;
    const successScore = successRate * 40;

    // Failure penalty — consecutive failures get exponentially worse.
    // A provider failing 3+ times in a row is effectively blacklisted.
    const consecutiveFailures = stats?.consecutiveFailures ?? 0;
    const failurePenalty = Math.min( 50, consecutiveFailures * 8 );

    // Latency score — penalize slow providers more aggressively.
    // Anything above 10s gets heavily penalized.
    const latencyMs = stats?.latencyEwmaMs ?? 0;
    const latencyScore = latencyMs > 0 ? Math.max( 0, 20 * ( 1 - latencyMs / 15_000 ) ) : 10;

    // Speed hints (flash-lite, mini, fast models)
    const speedHint = scoreModelSpeedHint( firstModel );

    // Freshness bonus — prefer providers that haven't been tried recently
    // This spreads load and avoids hot-spotting on a single provider.
    const freshnessBonus = stats?.lastUpdatedAt
        ? Math.min( 5, ( Date.now() - stats.lastUpdatedAt ) / 60_000 )
        : 3; // No data yet = neutral bonus

    // Sample count penalty — penalize providers we've never successfully used
    // to prefer known-good providers over unknown ones.
    const sampleCount = stats?.sampleCount ?? 0;
    const noveltyPenalty = sampleCount === 0 ? 2 : 0;

    return exactScore + successScore + latencyScore + speedHint + freshnessBonus
        - failurePenalty - noveltyPenalty;
}

export function getCandidateModelsForProvider( state: BackendState, config: OpenAIModelConfig, requestedModel: string ): string[] {
    const explicitlyAuto = isAutoModel( requestedModel );
    const modelInThisProvider = config.models.some( m => {
        const candidate = typeof m === 'string' ? m : ( m as any ).model;
        return stripFreeModifier( candidate ).normalizedId === stripFreeModifier( requestedModel ).normalizedId;
    } );
    const isAutoModelFlag = explicitlyAuto || !modelInThisProvider;

    /**
     * Filter out models that are currently on cooldown (recently failed).
     * This prevents the loop from trying a provider-model pair that just errored.
     */
    const filterHealthy = ( models: string[] ): string[] => {
        return models.filter( model => {
            const remainingMs = backendCooldownManager.getRemainingMs( config.id, model );
            if ( remainingMs > 0 ) return false;

            // Also skip if consecutive failures are too high (>5 failures)
            const stats = state.providerStats.getStats( config.id, model );
            if ( stats && stats.consecutiveFailures >= 5 ) return false;

            return true;
        } );
    };

    if ( config.randomRouting === false && !isAutoModelFlag ) {
        return filterHealthy( [requestedModel] );
    }

    const modelNames = config.models.map( m => ( typeof m === 'string' ? m : ( m as any ).model ) );
    if ( !isAutoModelFlag ) {
        return filterHealthy( [requestedModel] );
    }
    const uniqueModels = filterHealthy( Array.from( new Set( modelNames ) ) );
    if ( !uniqueModels.length ) return [];

    return uniqueModels.sort( ( left, right ) =>
        scoreModelForProvider( state, config, right ) - scoreModelForProvider( state, config, left )
    );
}

function scoreModelForProvider( state: BackendState, config: OpenAIModelConfig, modelName: string ): number {
    const stats = state.providerStats.getStats( config.id, modelName );
    const successRate = stats?.successRateEwma ?? 1;
    const successScore = successRate * 30;
    const latencyMs = stats?.latencyEwmaMs ?? 0;
    const latencyScore = latencyMs > 0 ? Math.max( 0, 15 * ( 1 - latencyMs / 10_000 ) ) : 7.5;
    const consecutiveFailures = stats?.consecutiveFailures ?? 0;
    const failurePenalty = Math.min( 40, consecutiveFailures * 6 );
    return successScore + latencyScore + scoreModelSpeedHint( modelName ) - failurePenalty;
}

export function scoreModelSpeedHint( modelName: string ): number {
    const normalized = stripFreeModifier( modelName ).normalizedId.toLowerCase();
    let score = 0;
    if ( normalized.includes( 'flash-lite' ) || normalized.includes( 'lite' ) ) score += 2;
    else if ( FAST_MODEL_HINTS.some( hint => normalized.includes( hint ) ) ) score += 1;
    if ( normalized.includes( 'preview' ) ) score -= 0.25;
    return score;
}
