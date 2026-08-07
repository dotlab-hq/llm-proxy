export type NormalizedModelId = {
    normalizedId: string;
    isFree: boolean;
};

const FREE_PREFIX = 'free:';
const FREE_SUFFIX = ':free';

/**
 * stripFreeModifier is called hundreds of times per request during routing
 * (every config × model comparison in getBackendsForModel /
 * getCandidateModelsForProvider). Model IDs come from a small, bounded set
 * (config-declared models + per-request model names), so memoize aggressively
 * to avoid repeated trim/slice allocations. Entries are immutable by contract —
 * callers only read `.normalizedId` / `.isFree`.
 */
const MAX_MODEL_ID_CACHE = 2000;
const modelIdCache = new Map<string, NormalizedModelId>();

export function stripFreeModifier( modelId: string ): NormalizedModelId {
    const key = modelId ?? '';
    const cached = modelIdCache.get( key );
    if ( cached ) return cached;

    const trimmed = key.trim();
    let normalizedId = trimmed;
    let isFree = false;

    if ( normalizedId.startsWith( FREE_PREFIX ) ) {
        normalizedId = normalizedId.slice( FREE_PREFIX.length );
        isFree = true;
    }

    if ( normalizedId.endsWith( FREE_SUFFIX ) ) {
        normalizedId = normalizedId.slice( 0, -FREE_SUFFIX.length );
        isFree = true;
    }

    const result = { normalizedId, isFree };
    if ( modelIdCache.size >= MAX_MODEL_ID_CACHE ) {
        const firstKey = modelIdCache.keys().next().value;
        if ( firstKey !== undefined ) modelIdCache.delete( firstKey );
    }
    modelIdCache.set( key, result );
    return result;
}
