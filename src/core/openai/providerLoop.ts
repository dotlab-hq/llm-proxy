import type { Context } from 'hono';
import { rateLimitManager } from '../RateLimitManager';
import { backendCooldownManager } from '../BackendCooldownManager';
import { HedgedDispatcher, HedgedDispatchExhaustedError } from '../HedgedDispatcher';
import { isDebugEnabled, redactForLog } from '@/utils/debug';
import { formatTimingEntries } from '@/utils/timing';
import { CONFIG } from '@/utils/schema.lookup';
import {
    isStringContentOnlyProvider,
    normalizeMessagesContentToString,
    getGroupSpace,
    DEFAULT_GROUP_SPACE,
} from '../routing/shared';
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
    attachUsageIfMissing,
    ensureToolCallThoughtSignatures,
    isRedirectStatus,
    extractModelFromLocation,
    parseResponsePayload,
    getEffectiveRateLimit,
    fetchWithProxy,
    stripGeminiOption,
    ensureToolCallReasoningContent,
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

/** Maximum total time (ms) the fallback loop may spend before giving up. */
const TOTAL_REQUEST_BUDGET_MS = 45_000;

/** Per-upstream timeout for non-streaming requests (ms). */
const UPSTREAM_NON_STREAM_TIMEOUT_MS = 30_000;

/** How many providers to race in parallel for non-streaming requests. */
const HEDGED_WIDTH = 2;

/** A ranked candidate for hedged dispatch. */
type ProviderCandidate = {
    config: OpenAIModelConfig;
    selectedModel: string;
    upstreamBody: any;
    url: string;
    headers: Record<string, string>;
};

/** Result of a single upstream attempt. */
type UpstreamAttemptResult = {
    ok: true;
    config: OpenAIModelConfig;
    selectedModel: string;
    response: Response;
    upstreamBody: any;
    upstreamRequestStartedAt: number;
    upstreamResponseReceivedAt: number;
};

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

    // Only text-chat endpoints carry message content that must be gated by
    // provider modalities (embeddings/STT/TTS/images endpoints are already
    // filtered by endpoint-specific flags).
    const requiredModalities = getRequiredInputModalities( body );
    const targetGroup = c.req.header( 'x-group-space' ) || DEFAULT_GROUP_SPACE;

    const matchingBackends = getBackendsForModel( state, modelName, endpoint, requiredModalities, targetGroup );
    if ( !matchingBackends.length ) {
        console.error( `[${endpoint}] No backends found for model: ${modelName}` );
        if ( isStreamingResponses ) return { response: sendResponsesStreamError( modelName, `Model not found: ${modelName}` ) };
        return { response: c.json( { error: { message: `Model not found: ${modelName}`, type: 'invalid_request_error' } }, 400 ) };
    }

    const backends = getOptimizedBackends( state, modelName, endpoint, matchingBackends, requiredModalities );
    if ( isDebugEnabled() ) console.info( `[${endpoint}] Attempting backends for model ${modelName}: ${backends.map( b => b.id ).join( ', ' )}` );

    // ─── Build flat candidate list (config + model pairs) for hedged dispatch ───
    const allCandidates: ProviderCandidate[] = [];
    // url/headers depend only on (config, endpoint) — reuse across the config's
    // candidate models instead of rebuilding per candidate.
    const requestPlanCache = new Map<string, { url: string; headers: Record<string, string> }>();
    for ( const config of backends ) {
        const candidateModels = getCandidateModelsForProvider( state, config, modelName, requiredModalities );
        for ( const selectedModel of candidateModels ) {
            const cooldownRemainingMs = backendCooldownManager.getRemainingMs( config.id, selectedModel );
            if ( cooldownRemainingMs > 0 ) {
                console.warn( `[${endpoint}] cooldown_active provider=${config.id} model=${selectedModel} remainingMs=${cooldownRemainingMs}` );
                continue;
            }
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
            rateLimitCompletedAt = Date.now();

            if ( !rateCheck.allowed ) {
                console.error( `[${endpoint}] Rate limit exceeded for ${config.id} - need ${tokens} tokens` );
                continue;
            }

            let requestPlan = requestPlanCache.get( config.id );
            if ( !requestPlan ) {
                requestPlan = { url: buildApiUrl( config, endpoint ), headers: buildHeaders( config ) };
                requestPlanCache.set( config.id, requestPlan );
            }

            allCandidates.push( {
                config,
                selectedModel,
                upstreamBody,
                url: requestPlan.url,
                headers: requestPlan.headers,
            } );
        }
    }

    // ─── Phase 1: Hedged dispatch — race top candidates in parallel ───
    if ( !body.stream && allCandidates.length >= 2 ) {
        try {
            const hedgedDispatcher = new HedgedDispatcher( { defaultMaxWidth: HEDGED_WIDTH } );
            const hedgedResult = await hedgedDispatcher.dispatch(
                allCandidates,
                async ( candidate, ctx ) => {
                    if ( ctx.signal.aborted ) throw new DOMException( 'Aborted', 'AbortError' );

                    const t0 = Date.now();
                    const response = await fetchWithProxy( candidate.url, {
                        method: 'POST',
                        headers: candidate.headers,
                        body: JSON.stringify( candidate.upstreamBody ),
                        signal: ctx.signal as any,
                    }, CONFIG.proxy );
                    const t1 = Date.now();

                    backendCooldownManager.markFromStatus( candidate.config.id, candidate.selectedModel, response.status );

                    if ( isRedirectStatus( response.status ) ) {
                        const location = response.headers.get( 'location' );
                        if ( location ) {
                            const redirectModel = extractModelFromLocation( location );
                            if ( redirectModel && redirectModel !== candidate.selectedModel ) {
                                const errRedirect: any = new Error( `redirect to ${redirectModel}` );
                                errRedirect.redirectModel = redirectModel;
                                throw errRedirect;
                            }
                        }
                    }

                    if ( response.status === 429 ) {
                        state.providerStats.recordFailure( candidate.config.id, candidate.selectedModel, t1 - t0 );
                        throw new Error( `429 from ${candidate.config.id}` );
                    }
                    if ( !response.ok ) {
                        const payload = await parseResponsePayload( response );
                        state.providerStats.recordFailure( candidate.config.id, candidate.selectedModel, t1 - t0 );
                        throw Object.assign( new Error( `${response.status} from ${candidate.config.id}` ), { payload, status: response.status } );
                    }

                    const responseContentType = response.headers.get( 'content-type' ) ?? '';
                    if ( candidate.upstreamBody.stream === true && responseContentType.includes( 'application/json' ) ) {
                        const errorPayload = await parseResponsePayload( response );
                        if ( errorPayload?.type === 'error' || errorPayload?.error ) {
                            state.providerStats.recordFailure( candidate.config.id, candidate.selectedModel, t1 - t0 );
                            throw new Error( `upstream_error_in_body from ${candidate.config.id}` );
                        }
                    }

                    return {
                        config: candidate.config,
                        selectedModel: candidate.selectedModel,
                        response,
                        upstreamBody: candidate.upstreamBody,
                        upstreamRequestStartedAt: t0,
                        upstreamResponseReceivedAt: t1,
                    } as UpstreamAttemptResult;
                },
                { signal: c.req.raw.signal }
            );

            // Hedged dispatch succeeded — handle the winning response
            const winner = hedgedResult.value;
            state.providerStats.recordSuccess( winner.config.id, winner.selectedModel, winner.upstreamResponseReceivedAt - winner.upstreamRequestStartedAt );
            backendCooldownManager.recordSuccess( winner.config.id );
            console.info( `[${endpoint}] hedged_winner provider=${winner.config.id} model=${winner.selectedModel} rank=${hedgedResult.rank} attempts=${hedgedResult.attemptedCount} ms=${winner.upstreamResponseReceivedAt - winner.upstreamRequestStartedAt}` );

            const payload = await parseResponsePayload( winner.response );
            let finalPayload = payload;
            if ( args.originalResponsesBody ) {
                finalPayload = convertChatResponseToResponses( payload, args.originalResponsesBody, args.fileSearchCalls );
                finalPayload = attachUsageIfMissing( 'responses', args.originalResponsesBody, finalPayload );
            } else {
                finalPayload = attachUsageIfMissing( endpoint, winner.upstreamBody, finalPayload );
            }
            const totalMs = Date.now() - requestStartedAt;
            const serverTiming = formatTimingEntries( {
                body_parse: bodyParsedAt - requestStartedAt,
                web_search: webSearchCompletedAt - requestStartedAt,
                rate_limit: rateLimitCompletedAt - requestStartedAt,
                upstream: winner.upstreamResponseReceivedAt - winner.upstreamRequestStartedAt,
                transform: Date.now() - winner.upstreamResponseReceivedAt,
                total: totalMs,
            } );
            if ( serverTiming ) c.header( 'Server-Timing', serverTiming );
            return { response: c.json( finalPayload, winner.response.status as any ) };
        } catch ( err: any ) {
            if ( err instanceof HedgedDispatchExhaustedError ) {
                console.warn( `[${endpoint}] hedged_exhausted — all ${err.attemptedCount} parallel attempts failed, falling back to sequential` );
                // Prefer a redirect signalled by any hedged attempt over failures,
                // since redirects are a short-circuit outcome rather than a backend error.
                for ( const f of err.failures ) {
                    const errObj = f.error as any;
                    if ( errObj?.redirectModel ) {
                        return { redirect: { model: errObj.redirectModel } };
                    }
                }
                // Record failures for each hedged attempt
                for ( const f of err.failures ) {
                    const failedCandidate = f.candidate as ProviderCandidate;
                    state.providerStats.recordFailure( failedCandidate.config.id, failedCandidate.selectedModel );
                }
            } else if ( err?.name === 'AbortError' ) {
                // Client disconnected or budget exceeded
                return { lastFailure: { status: 499, payload: { error: { message: 'Request cancelled' } } } };
            } else {
                console.error( `[${endpoint}] hedged_unexpected_error: ${err?.message}` );
            }
            // Fall through to sequential loop
        }
    }

    // ─── Phase 1→2 boundary: give up before sequential fallback if the budget has already burned up ───
    if ( Date.now() - requestStartedAt > TOTAL_REQUEST_BUDGET_MS ) {
        console.warn( `[${endpoint}] request_budget_exceeded_before_sequential elapsedMs=${Date.now() - requestStartedAt} budgetMs=${TOTAL_REQUEST_BUDGET_MS}` );
        if ( lastFailure ) {
            return { lastFailure };
        }
    }

    // ─── Phase 2: Sequential fallback — try remaining candidates one by one ───
    for ( const candidate of allCandidates ) {
        const { config, selectedModel, upstreamBody, url, headers } = candidate;

        // Check total request budget — abort if we've spent too long trying fallbacks
        const elapsedMs = Date.now() - requestStartedAt;
        if ( elapsedMs > TOTAL_REQUEST_BUDGET_MS ) {
            console.warn( `[${endpoint}] request_budget_exceeded elapsedMs=${elapsedMs} budgetMs=${TOTAL_REQUEST_BUDGET_MS}` );
            break;
        }

        // Check if client disconnected — don't waste upstream requests
        if ( c.req.raw.signal?.aborted ) {
            console.info( `[${endpoint}] client_disconnected — aborting fallback loop` );
            break;
        }

        try {
            upstreamRequestStartedAt = Date.now();
            if ( isDebugEnabled() ) {
                console.info( `[${endpoint}] upstream_request model=${selectedModel} body=${JSON.stringify( redactForLog( upstreamBody ) )}` );
            }

            // Per-upstream timeout for non-streaming requests; combine with client disconnect signal
            const clientSignal = c.req.raw.signal;
            const upstreamTimeoutMs = upstreamBody.stream === true ? undefined : UPSTREAM_NON_STREAM_TIMEOUT_MS;
            const upstreamSignal = upstreamTimeoutMs
                ? AbortSignal.timeout( upstreamTimeoutMs )
                : undefined;
            // Race: first abort wins (client disconnect or timeout)
            const combinedSignal = ( clientSignal && upstreamSignal )
                ? AbortSignal.any( [clientSignal, upstreamSignal] )
                : clientSignal ?? upstreamSignal;

            const response = await fetchWithProxy( url, {
                method: 'POST',
                headers,
                body: JSON.stringify( upstreamBody ),
                signal: combinedSignal as any,
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

    if ( lastFailure ) {
        console.error( `
❌ [${endpoint}] FINAL FAILURE (${lastFailure.status})
Attempted backends: ${backends.map( b => b.id ).join( ', ' )}` );
        if ( isStreamingResponses ) return { response: sendResponsesStreamError( modelName, typeof lastFailure.payload === 'object' ? lastFailure.payload?.error?.message || JSON.stringify( lastFailure.payload ) : String( lastFailure.payload ) ) };
    }

    return { lastFailure: lastFailure ?? undefined };
}


