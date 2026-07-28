import type { Context } from 'hono';
import { rateLimitManager } from '../RateLimitManager';
import { backendCooldownManager } from '../BackendCooldownManager';
import { isDebugEnabled, redactForLog } from '@/utils/debug';
import { formatTimingEntries } from '@/utils/timing';
import { CONFIG } from '@/utils/schema.lookup';
import { isStringContentOnlyProvider, normalizeMessagesContentToString } from '../routing/shared';
import {
    getBackendsForModel,
    getOptimizedBackends,
    getCandidateModelsForProvider,
    isGeminiProvider,
} from './routing';
import {
    buildApiUrl,
    buildHeaders,
    calculateTokenCount,
    attachUsageIfMissing,
    ensureToolCallThoughtSignatures,
    isRedirectStatus,
    extractModelFromLocation,
    parseResponsePayload,
    getEffectiveRateLimit,
    fetchWithProxy,
} from './helpers';
import { withGeminiThinking, withReasoningEffort } from './reasoning';
import type { BackendState, OpenAIModelConfig } from './types';
import type { FileSearchCallItem } from '../ResponsesConversion';
import { convertChatResponseToResponses } from '../ResponsesConversion';
import { sendResponsesStreamError } from './responsesStream';
import { handleStreaming } from './streamingHandler';

export interface ProxyRequestArgs {
    c: Context;
    state: BackendState;
    endpoint: string;
    rawBody?: any;
    originalResponsesBody?: any;
    fileSearchCalls?: FileSearchCallItem[];
    redirectDepth?: number;
}

export interface ProxyRequestResult {
    // If set, a response was already sent/returned and the caller should return it.
    response?: Response | any;
    // If set, the loop exhausted all backends but found no success.
    lastFailure?: { status: number; payload: any };
    // If set, the loop redirected to a different model.
    redirect?: { model: string };
}

/**
 * Core provider-fallback loop shared by proxyRequest and processUpstreamWithFallback.
 * Iterates candidate backends, builds the upstream request, applies rate limits /
 * cooldowns, and on success handles streaming vs. non-streaming responses.
 */
function stripGeminiOption( body: any ): any {
    if ( body?.extra?.gemini !== true ) return body;
    const { extra, ...rest } = body;
    const { gemini, ...remainingExtra } = extra;
    return Object.keys( remainingExtra ).length ? { ...rest, extra: remainingExtra } : rest;
}

export async function runProxyRequest( args: ProxyRequestArgs ): Promise<ProxyRequestResult> {
    const { c, state, endpoint } = args;
    const redirectDepth = args.redirectDepth ?? 1;
    const requestStartedAt = Date.now();
    let bodyParsedAt = requestStartedAt;
    let webSearchCompletedAt = requestStartedAt;
    let rateLimitCompletedAt = requestStartedAt;
    let upstreamRequestStartedAt = requestStartedAt;
    let upstreamResponseReceivedAt = requestStartedAt;

    const resolvedBody = args.rawBody ?? await c.req.json().catch( () => ( {} ) );
    bodyParsedAt = Date.now();

    const body = resolvedBody;
    const modelName = body.model;
    let lastFailure: { status: number; payload: any } | null = null;

    if ( !modelName || typeof modelName !== 'string' ) {
        return { response: c.json( { error: { message: 'Model is required and must be a string', type: 'invalid_request_error' } }, 400 ) };
    }

    const maxRedirects = 5;
    if ( redirectDepth > maxRedirects ) {
        return { response: c.json( { error: { message: 'Maximum redirect depth exceeded', type: 'invalid_request_error' } }, 400 ) };
    }

    const isResponsesApi = !!args.originalResponsesBody;
    const originalStreamFlag = args.originalResponsesBody?.stream === true || body.stream === true;
    const isStreamingResponses = isResponsesApi && originalStreamFlag;

    const matchingBackends = getBackendsForModel( state, modelName, endpoint );
    if ( !matchingBackends.length ) {
        console.error( `[${endpoint}] No backends found for model: ${modelName}` );
        if ( isStreamingResponses ) return { response: sendResponsesStreamError( modelName, `Model not found: ${modelName}` ) };
        return { response: c.json( { error: { message: `Model not found: ${modelName}`, type: 'invalid_request_error' } }, 400 ) };
    }

    const backends = getOptimizedBackends( state, modelName, endpoint, matchingBackends );
    console.error( `[${endpoint}] Attempting backends for model ${modelName}: ${backends.map( b => b.id ).join( ', ' )}` );

    for ( const config of backends ) {
        const candidateModels = getCandidateModelsForProvider( state, config, modelName );

        for ( const selectedModel of candidateModels ) {
            const cooldownRemainingMs = backendCooldownManager.getRemainingMs( config.id, selectedModel );
            if ( cooldownRemainingMs > 0 ) {
                console.warn( `[${endpoint}] cooldown_active provider=${config.id} model=${selectedModel} remainingMs=${cooldownRemainingMs}` );
                continue;
            }

            const requestWithModel = { ...body, model: selectedModel };
            const withReasoning = withReasoningEffort( requestWithModel, config, selectedModel );
            const upstreamBodyRaw = isGeminiProvider( config ) ? ensureToolCallThoughtSignatures( withGeminiThinking( withReasoning, selectedModel ) ) : stripGeminiOption( withReasoning );
            const upstreamBody = isStringContentOnlyProvider( config )
                ? normalizeMessagesContentToString( upstreamBodyRaw )
                : upstreamBodyRaw;

            const tokens = calculateTokenCount( upstreamBody );
            const rateLimit = getEffectiveRateLimit( config );
            const rateCheck = await rateLimitManager.checkAndConsume( config.id, tokens, rateLimit, selectedModel );
            rateLimitCompletedAt = Date.now();

            if ( !rateCheck.allowed ) {
                console.error( `[${endpoint}] Rate limit exceeded for ${config.id} - need ${tokens} tokens` );
                continue;
            }

            try {
                const url = buildApiUrl( config, endpoint );
                upstreamRequestStartedAt = Date.now();
                if ( isDebugEnabled() ) {
                    console.info( `[${endpoint}] upstream_request model=${selectedModel} body=${JSON.stringify( redactForLog( upstreamBody ) )}` );
                }

                const response = await fetchWithProxy( url, {
                    method: 'POST',
                    headers: buildHeaders( config ),
                    body: JSON.stringify( upstreamBody ),
                }, CONFIG.proxy, { skipTimeout: upstreamBody.stream === true } );
                upstreamResponseReceivedAt = Date.now();

                backendCooldownManager.markFromStatus( config.id, selectedModel, response.status );
                if ( response.status === 429 ) {
                    state.providerStats.recordFailure( config.id, selectedModel, upstreamResponseReceivedAt - upstreamRequestStartedAt );
                    continue;
                }

                if ( isRedirectStatus( response.status ) ) {
                    const location = response.headers.get( 'location' );
                    if ( location ) {
                        const redirectModel = extractModelFromLocation( location );
                        if ( redirectModel && redirectModel !== modelName ) {
                            return { redirect: { model: redirectModel } };
                        }
                    }
                }

                if ( !response.ok ) {
                    lastFailure = { status: response.status, payload: await parseResponsePayload( response ) };
                    state.providerStats.recordFailure( config.id, selectedModel, upstreamResponseReceivedAt - upstreamRequestStartedAt );
                    console.error( `[${endpoint}] ${response.status} from ${config?.id ?? config?.name}` );
                    continue;
                }

                const responseContentType = response.headers.get( 'content-type' ) ?? '';
                if ( upstreamBody.stream === true && responseContentType.includes( 'application/json' ) ) {
                    const errorPayload = await parseResponsePayload( response );
                    if ( errorPayload?.type === 'error' || errorPayload?.error ) {
                        const errorMsg = errorPayload?.error?.message || errorPayload?.error || JSON.stringify( errorPayload );
                        lastFailure = { status: 200, payload: errorPayload };
                        state.providerStats.recordFailure( config.id, selectedModel, upstreamResponseReceivedAt - upstreamRequestStartedAt );
                        console.error( `[${endpoint}] upstream_error_in_body(stream) from ${config?.id ?? config?.name}` );
                        continue;
                    }
                }

                if ( upstreamBody.stream === true ) {
                    const streamed = await handleStreaming( {
                        c, state, response, endpoint, config, selectedModel,
                        upstreamBody, originalResponsesBody: args.originalResponsesBody,
                        fileSearchCalls: args.fileSearchCalls,
                        timings: {
                            requestStartedAt, bodyParsedAt, webSearchCompletedAt,
                            rateLimitCompletedAt, upstreamRequestStartedAt, upstreamResponseReceivedAt,
                        },
                    } );
                    state.providerStats.recordSuccess( config.id, selectedModel, upstreamResponseReceivedAt - upstreamRequestStartedAt );
                    backendCooldownManager.recordSuccess( config.id );
                    return { response: streamed };
                }

                const payload = await parseResponsePayload( response );
                if ( isDebugEnabled() ) {
                    console.info( `[${endpoint}] upstream_response model=${selectedModel} status=${response.status} body=${JSON.stringify( redactForLog( payload ) )}` );
                }

                if ( !response.ok ) {
                    lastFailure = { status: response.status, payload };
                    state.providerStats.recordFailure( config.id, selectedModel, upstreamResponseReceivedAt - upstreamRequestStartedAt );
                    console.error( `[${endpoint}] ${response.status} from ${config?.id ?? config?.name}` );
                    continue;
                }

                if ( payload?.type === 'error' || ( payload?.error && !payload?.choices ) ) {
                    const errorMsg = payload?.error?.message || payload?.error || JSON.stringify( payload );
                    lastFailure = { status: 200, payload };
                    state.providerStats.recordFailure( config.id, selectedModel, upstreamResponseReceivedAt - upstreamRequestStartedAt );
                    console.error( `[${endpoint}] upstream_error_in_body from ${config?.id ?? config?.name}` );
                    continue;
                }

                let finalPayload = payload;
                if ( args.originalResponsesBody ) {
                    finalPayload = convertChatResponseToResponses( payload, args.originalResponsesBody, args.fileSearchCalls );
                    finalPayload = attachUsageIfMissing( 'responses', args.originalResponsesBody, finalPayload );
                } else {
                    finalPayload = attachUsageIfMissing( endpoint, upstreamBody, finalPayload );
                }
                const transformMs = Date.now() - upstreamResponseReceivedAt;
                const totalMs = Date.now() - requestStartedAt;
                const serverTiming = formatTimingEntries( {
                    body_parse: bodyParsedAt - requestStartedAt,
                    web_search: webSearchCompletedAt - requestStartedAt,
                    rate_limit: rateLimitCompletedAt - requestStartedAt,
                    upstream: upstreamResponseReceivedAt - upstreamRequestStartedAt,
                    transform: transformMs, total: totalMs,
                } );
                if ( serverTiming ) c.header( 'Server-Timing', serverTiming );
                console.info( `[${endpoint}] success provider=${config.id} model=${selectedModel} bodyParseMs=${bodyParsedAt - requestStartedAt} webSearchMs=${webSearchCompletedAt - requestStartedAt} rateLimitMs=${rateLimitCompletedAt - requestStartedAt} upstreamMs=${upstreamResponseReceivedAt - upstreamRequestStartedAt} transformMs=${transformMs} totalMs=${totalMs}` );
                state.providerStats.recordSuccess( config.id, selectedModel, upstreamResponseReceivedAt - upstreamRequestStartedAt );
                backendCooldownManager.recordSuccess( config.id );
                return { response: c.json( finalPayload, response.status as any ) };
            } catch ( error: any ) {
                lastFailure = {
                    status: 502,
                    payload: { error: { message: error?.message || 'Upstream request failed', type: 'upstream_error' } },
                };
                state.providerStats.recordFailure( config.id, selectedModel );
                console.error( `[${endpoint}] Exception from ${config?.id ?? config?.name}: ${error?.message || String( error )}` );
                continue;
            }
        }
    }

    if ( lastFailure ) {
        console.error( `
❌ [${endpoint}] FINAL FAILURE (${lastFailure.status})
Attempted backends: ${backends.map( b => b.id ).join( ', ' )}` );
        if ( isStreamingResponses ) return { response: sendResponsesStreamError( modelName, typeof lastFailure.payload === 'object' ? lastFailure.payload?.error?.message || JSON.stringify( lastFailure.payload ) : String( lastFailure.payload ) ) };
    }

    return { lastFailure: lastFailure ?? undefined };
}


