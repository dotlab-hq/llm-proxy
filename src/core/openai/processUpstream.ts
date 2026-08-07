import { rateLimitManager } from '../RateLimitManager';
import { backendCooldownManager } from '../BackendCooldownManager';
import { fetchWithProxy } from '@/utils/proxyFetch';
import { CONFIG } from '@/utils/schema.lookup';
import { isStringContentOnlyProvider, normalizeMessagesContentToString } from '../routing/shared';
import {
    getBackendsForModel,
    getOptimizedBackends,
    getCandidateModelsForProvider,
    getRequiredInputModalities,
    isGeminiProvider,
} from './routing';
import {
    buildApiUrl,
    buildHeaders,
    calculateTokenCount,
    ensureToolCallThoughtSignatures,
    isRedirectStatus,
    extractModelFromLocation,
    getEffectiveRateLimit,
    stripGeminiOption,
    ensureToolCallReasoningContent,
} from './helpers';
import { isDebugEnabled } from '@/utils/debug';
import { withGeminiThinking, withReasoningEffort } from './reasoning';
import type { BackendState, OpenAIModelConfig } from './types';

export async function processUpstreamWithFallback(
    state: BackendState,
    body: any,
    endpoint: string,
    options: {
        responseId: string;
        model: string;
        stream?: boolean;
        targetGroup?: string;
    },
): Promise<{ status: number; payload?: any; response?: Response; providerId?: string; selectedModel?: string }> {
    const requestStartedAt = Date.now();
    const modelName = options.model;

    if ( !modelName || typeof modelName !== 'string' ) {
        return {
            status: 400,
            payload: { error: { message: 'Model is required and must be a string', type: 'invalid_request_error' } },
        };
    }

    const requiredModalities = getRequiredInputModalities( body );

    const matchingBackends = getBackendsForModel( state, modelName, endpoint, requiredModalities, options.targetGroup );
    if ( !matchingBackends.length ) {
        console.error( `[ws:${endpoint}] No backends found for model: ${modelName}` );
        return {
            status: 400,
            payload: { error: { message: `Model not found: ${modelName}`, type: 'invalid_request_error' } },
        };
    }

    const backends = getOptimizedBackends( state, modelName, endpoint, matchingBackends, requiredModalities );
    if ( isDebugEnabled() ) console.info( `[ws:${endpoint}] Attempting backends for model ${modelName}: ${backends.map( b => b.id ).join( ', ' )}` );

    // url/headers depend only on (config, endpoint) — reuse across the config's
    // candidate models instead of rebuilding per candidate.
    const requestPlanCache = new Map<string, { url: string; headers: Record<string, string> }>();

    for ( const config of backends ) {
        const candidateModels = getCandidateModelsForProvider( state, config, modelName, requiredModalities );

        for ( const selectedModel of candidateModels ) {
            const cooldownRemainingMs = backendCooldownManager.getRemainingMs( config.id, selectedModel );
            if ( cooldownRemainingMs > 0 ) continue;

            const requestWithModel = { ...body, model: selectedModel };
            const withReasoning = withReasoningEffort( requestWithModel, config, selectedModel );
            const reasoningCompatible = ensureToolCallReasoningContent( withReasoning );
            const upstreamBodyRaw = isGeminiProvider( config ) ? ensureToolCallThoughtSignatures( withGeminiThinking( reasoningCompatible, selectedModel ) ) : stripGeminiOption( reasoningCompatible );
            const upstreamBody = isStringContentOnlyProvider( config )
                ? normalizeMessagesContentToString( upstreamBodyRaw )
                : upstreamBodyRaw;

            const tokens = calculateTokenCount( upstreamBody );
            const rateLimit = getEffectiveRateLimit( config );
            const rateCheck = await rateLimitManager.checkAndConsume( config.id, tokens, rateLimit, selectedModel );
            if ( !rateCheck.allowed ) continue;

            try {
                let requestPlan = requestPlanCache.get( config.id );
                if ( !requestPlan ) {
                    requestPlan = { url: buildApiUrl( config, endpoint ), headers: buildHeaders( config ) };
                    requestPlanCache.set( config.id, requestPlan );
                }
                const upstreamResponse = await fetchWithProxy( requestPlan.url, {
                    method: 'POST',
                    headers: requestPlan.headers,
                    body: JSON.stringify( upstreamBody ),
                }, CONFIG.proxy, { skipTimeout: upstreamBody.stream === true } );

                backendCooldownManager.markFromStatus( config.id, selectedModel, upstreamResponse.status );
                if ( upstreamResponse.status === 429 ) {
                    state.providerStats.recordFailure( config.id, selectedModel );
                    console.warn( `[ws:${endpoint}] 429 from ${config.id}, trying next backend` );
                    continue;
                }

                if ( isRedirectStatus( upstreamResponse.status ) ) {
                    const location = upstreamResponse.headers.get( 'location' );
                    if ( location ) {
                        const redirectModel = extractModelFromLocation( location );
                        if ( redirectModel && redirectModel !== modelName ) {
                            return processUpstreamWithFallback( state, { ...body, model: redirectModel }, endpoint, { ...options, model: redirectModel } );
                        }
                    }
                }

                if ( !upstreamResponse.ok ) {
                    state.providerStats.recordFailure( config.id, selectedModel );
                    console.error( `[ws:${endpoint}] ${upstreamResponse.status} from ${config.id} — trying next backend` );
                    continue;
                }

                state.providerStats.recordSuccess( config.id, selectedModel );
                return {
                    status: upstreamResponse.status,
                    response: upstreamResponse,
                    providerId: config.id,
                    selectedModel,
                };
            } catch ( error: any ) {
                state.providerStats.recordFailure( config.id, selectedModel );
                console.error( `[ws:${endpoint}] Exception from ${config?.id}: ${error?.message || String( error )}` );
                continue;
            }
        }
    }

    console.error( `[ws:${endpoint}] ALL PROVIDERS FAILED for model ${modelName}` );
    return {
        status: 502,
        payload: { error: { message: 'All providers failed', type: 'internal_error' } },
    };
}


