import type { Context } from 'hono';
import type { AnthropicProxy } from './index';
import { runCodeInterpreter } from './codeInterpreter';
import { handleLastFailure, handleAllProvidersFailed } from './responses';
import { handleStreamingResponse } from './streaming';
import { isStringContentOnlyProvider, normalizeMessagesContentToString } from '../routing/shared';
import { HedgedDispatcher, HedgedDispatchExhaustedError } from '../HedgedDispatcher';

const STREAM_HEDGE_WIDTH = 2;

type StreamingCandidate = {
    config: any;
    selectedModel: string;
    openAIRequest: any;
    url: string;
};
export async function handleModels( proxy: AnthropicProxy, c: Context ) {
    const { CONFIG } = proxy;
    try {
        const configs = CONFIG.models.openai;
        if ( !configs || !configs.length ) {
            console.error( '[/anthropic/v1/models] No OpenAI backend configured' );
            return c.json( { error: 'No OpenAI backend configured' }, 503 );
        }

        const catalog = await proxy.getUnifiedModelCatalog();
        return c.json( {
            object: 'list',
            data: catalog.data,
        } );
    } catch ( error: any ) {
        console.error( '[/anthropic/v1/models] Exception:', error?.message || String( error ) );
        return c.json( { error: 'Failed to fetch models' }, 500 );
    }
}

export async function handleMessages( proxy: AnthropicProxy, c: Context ) {
    const requestStartedAt = Date.now();
    const rawBody = await c.req.json().catch( () => ( {} ) );
    const bodyParsedAt = Date.now();

    const savedContainerId: string | undefined = rawBody?.container?.id;
    if ( proxy.isSkillResolverReady() ) {
        await proxy.resolveAnthropicBody( rawBody );
    }

    const webSearchContext = await proxy.webSearchHandler.prepareAnthropicWebSearch( rawBody );
    const webSearchCompletedAt = Date.now();
    if ( webSearchContext.errorResponse ) {
        return c.json( webSearchContext.errorResponse.body, webSearchContext.errorResponse.status as any );
    }

    const body = webSearchContext.body;
    const requestedModel = body.model;
    const requiredModalities = proxy.getRequiredModalities( body );
    const hadToolSearchRequest = proxy.hasAnthropicToolSearchRequest( body );
    let lastFailure: { status: number; payload: any } | null = null;

    if ( !requestedModel || typeof requestedModel !== 'string' ) {
        return c.json( {
            error: {
                message: 'Model is required and must be a string',
                type: 'invalid_request_error',
            },
        }, 400 );
    }

    if ( proxy.codeInterpreterHandler.shouldUseCodeInterpreter( body ) ) {
        const ciResult = await runCodeInterpreter( proxy, c, body, requestedModel, requestStartedAt, bodyParsedAt, webSearchCompletedAt );
        if ( !ciResult.handled ) {
            // not handled by code interpreter
        } else if ( 'response' in ciResult ) {
            return ciResult.response;
        } else {
            lastFailure = ciResult.failure;
        }
    }

    const endpoint = 'messages';
    const matchingBackends = proxy.getBackendsForModel( requestedModel, requiredModalities );
    if ( !matchingBackends.length ) {
        console.error( `[${endpoint}] No OpenAI backends found for model: ${requestedModel}` );
        return c.json( {
            error: {
                message: `Model not found: ${requestedModel}`,
                type: 'invalid_request_error',
            },
        }, 400 );
    }

    const backends = proxy.getOptimizedBackends( requestedModel, matchingBackends, requiredModalities );

    const backendIds = backends.map( b => b.id ).join( ', ' );
    console.error( `[${endpoint}] Attempting OpenAI backends for model ${requestedModel}: ${backendIds}` );

    // Stream attempts used to run strictly one after another. A slow 4xx/5xx
    // response therefore stalled fallback even though other providers were ready.
    // Race two response-header attempts; failures immediately start the next
    // candidate and the loser is aborted once one provider is usable.
    if ( body.stream === true ) {
        const streamingCandidates: StreamingCandidate[] = [];
        for ( const config of backends ) {
            for ( const selectedModel of proxy.getCandidateModelsForProvider( config, requestedModel, requiredModalities ) ) {
                if ( proxy.backendCooldownManager.getRemainingMs( config.id, selectedModel ) > 0 ) continue;

                const convertedRequest = proxy.convertAnthropicRequestToOpenAI( body, selectedModel, 'native' );
                const withReasoning = proxy.withReasoningEffort( convertedRequest, body, config, selectedModel );
                const openAIRequestRaw = proxy.isGeminiProvider( config )
                    ? proxy.ensureToolCallThoughtSignatures( withReasoning )
                    : withReasoning;
                const openAIRequest = isStringContentOnlyProvider( config )
                    ? normalizeMessagesContentToString( openAIRequestRaw )
                    : openAIRequestRaw;
                streamingCandidates.push( {
                    config,
                    selectedModel,
                    openAIRequest,
                    url: `${proxy.normalizeBaseUrl( config.baseUrl )}/${proxy.getOpenAIEndpointForAnthropicEndpoint( endpoint )}`,
                } );
            }
        }

        try {
            const result = await new HedgedDispatcher( { defaultMaxWidth: STREAM_HEDGE_WIDTH } ).dispatch(
                streamingCandidates,
                async ( candidate, dispatchContext ) => {
                    const tokens = proxy.calculateTokenCount( body );
                    const rateCheck = await proxy.rateLimitManager.checkAndConsume(
                        candidate.config.id, tokens, proxy.getEffectiveRateLimit( candidate.config ), candidate.selectedModel,
                    );
                    if ( !rateCheck.allowed ) {
                        throw Object.assign( new Error( `Rate limit exceeded for ${candidate.config.id}` ), { status: 429 } );
                    }

                    const attemptStartedAt = Date.now();
                    console.info( `[${endpoint}] attempt_started provider=${candidate.config.id} model=${candidate.selectedModel} rank=${dispatchContext.rank}` );
                    try {
                        const response = await proxy.fetchWithProxy( candidate.url, {
                            method: 'POST',
                            headers: proxy.buildHeaders( candidate.config, true ),
                            body: JSON.stringify( candidate.openAIRequest ),
                            signal: dispatchContext.signal,
                        }, proxy.CONFIG.proxy, { skipTimeout: true } );
                        const elapsedMs = Date.now() - attemptStartedAt;
                        proxy.backendCooldownManager.markFromStatus( candidate.config.id, candidate.selectedModel, response.status );
                        const contentType = response.headers.get( 'content-type' ) ?? '';
                        if ( !response.ok || !response.body || !contentType.includes( 'text/event-stream' ) ) {
                            response.body?.cancel().catch( () => {} );
                            proxy.providerStats.recordFailure( candidate.config.id, candidate.selectedModel, elapsedMs );
                            console.warn( `[${endpoint}] attempt_failed provider=${candidate.config.id} model=${candidate.selectedModel} status=${response.status} elapsedMs=${elapsedMs} rank=${dispatchContext.rank}` );
                            throw Object.assign( new Error( `${response.status} from ${candidate.config.id}` ), { status: response.status } );
                        }
                        return { ...candidate, response, upstreamRequestStartedAt: attemptStartedAt, upstreamResponseReceivedAt: Date.now() };
                    } catch ( error: any ) {
                        if ( error?.name !== 'AbortError' ) {
                            console.warn( `[${endpoint}] attempt_error provider=${candidate.config.id} model=${candidate.selectedModel} elapsedMs=${Date.now() - attemptStartedAt} rank=${dispatchContext.rank} error=${error?.message || String( error )}` );
                        }
                        throw error;
                    }
                },
                { signal: c.req.raw.signal },
            );

            const winner = result.value;
            console.info( `[${endpoint}] hedge_winner provider=${winner.config.id} model=${winner.selectedModel} rank=${result.rank} attempts=${result.attemptedCount}` );
            proxy.backendCooldownManager.recordSuccess( winner.config.id );
            return handleStreamingResponse(
                proxy, c, winner.response, winner.config, winner.selectedModel, requestedModel,
                webSearchContext.searchResponse, requestStartedAt, bodyParsedAt, webSearchCompletedAt,
                winner.upstreamResponseReceivedAt, winner.upstreamRequestStartedAt,
            );
        } catch ( error: any ) {
            if ( error?.name === 'AbortError' ) {
                return c.json( { error: { message: 'Request cancelled', type: 'request_cancelled' } }, 499 as any );
            }
            if ( error instanceof HedgedDispatchExhaustedError ) {
                const last = error.failures.at( -1 )?.error as { status?: number } | undefined;
                lastFailure = { status: last?.status ?? 502, payload: { error: { message: 'All streaming upstream attempts failed', type: 'upstream_error' } } };
            } else {
                lastFailure = { status: error?.status ?? 502, payload: { error: { message: error?.message || 'Upstream request failed', type: 'upstream_error' } } };
            }
        }
    }

    for ( const config of body.stream === true ? [] : backends ) {
        const candidateModels = proxy.getCandidateModelsForProvider( config, requestedModel, requiredModalities );

        for ( const selectedModel of candidateModels ) {
            const cooldownRemainingMs = proxy.backendCooldownManager.getRemainingMs( config.id, selectedModel );
            if ( cooldownRemainingMs > 0 ) {
                console.warn( `[${endpoint}] cooldown_active provider=${config.id} model=${selectedModel} remainingMs=${cooldownRemainingMs}` );
                continue;
            }

            const tokens = proxy.calculateTokenCount( body );
            const rateLimit = proxy.getEffectiveRateLimit( config );
            const rateCheck = await proxy.rateLimitManager.checkAndConsume(
                config.id,
                tokens,
                rateLimit,
                selectedModel
            );

            if ( !rateCheck.allowed ) {
                console.error( `[${endpoint}] Rate limit exceeded for ${config.id} - need ${tokens} tokens` );
                continue;
            }

            try {
                const convertedRequest = proxy.convertAnthropicRequestToOpenAI( body, selectedModel, 'native' );
                const withReasoning = proxy.withReasoningEffort( convertedRequest, body, config, selectedModel );
                const openAIRequestRaw = proxy.isGeminiProvider( config )
                    ? proxy.ensureToolCallThoughtSignatures( withReasoning )
                    : withReasoning;
                const openAIRequest = isStringContentOnlyProvider( config )
                    ? normalizeMessagesContentToString( openAIRequestRaw )
                    : openAIRequestRaw;
                const upstreamEndpoint = proxy.getOpenAIEndpointForAnthropicEndpoint( endpoint );
                const url = `${proxy.normalizeBaseUrl( config.baseUrl )}/${upstreamEndpoint}`;
                const upstreamRequestStartedAt = Date.now();
                if ( proxy.isDebugEnabled() ) {
                    console.info( `[messages] upstream_request model=${selectedModel} body=${JSON.stringify( proxy.redactForLog( openAIRequest ) )}` );
                }

                const response = await proxy.fetchWithProxy( url, {
                    method: 'POST',
                    headers: proxy.buildHeaders( config, openAIRequest.stream === true ),
                    body: JSON.stringify( openAIRequest ),
                }, proxy.CONFIG.proxy, { skipTimeout: openAIRequest.stream === true } );
                const upstreamResponseReceivedAt = Date.now();

                proxy.backendCooldownManager.markFromStatus( config.id, selectedModel, response.status );
                if ( response.status === 429 ) {
                    proxy.providerStats.recordFailure( config.id, selectedModel, upstreamResponseReceivedAt - upstreamRequestStartedAt );
                    continue;
                }

                const contentType = response.headers.get( 'content-type' ) ?? '';
                if ( openAIRequest.stream === true && response.ok && response.body && contentType.includes( 'text/event-stream' ) ) {
                    return handleStreamingResponse(
                        proxy, c, response, config, selectedModel, requestedModel,
                        webSearchContext.searchResponse, requestStartedAt, bodyParsedAt,
                        webSearchCompletedAt, upstreamResponseReceivedAt, upstreamRequestStartedAt
                    );
                }

                const transformStartedAt = Date.now();
                const payload = await proxy.parseResponsePayload( response );
                if ( proxy.isDebugEnabled() ) {
                    console.info( `[messages] upstream_response model=${selectedModel} status=${response.status} body=${JSON.stringify( proxy.redactForLog( payload ) )}` );
                }

                if ( !response.ok ) {
                    lastFailure = {
                        status: response.status,
                        payload,
                    };
                    proxy.providerStats.recordFailure( config.id, selectedModel, upstreamResponseReceivedAt - upstreamRequestStartedAt );
                    console.error( `[${endpoint}] ${response.status} from ${config?.id ?? config?.name}` );
                    continue;
                }

                if ( !payload || typeof payload !== 'object' || Array.isArray( payload ) ) {
                    lastFailure = {
                        status: 502,
                        payload: {
                            error: {
                                message: 'Upstream returned invalid OpenAI response',
                                type: 'upstream_error',
                            },
                        },
                    };
                    continue;
                }

                const responsePayload = payload as any;
                const promptTokens = proxy.calculateTokenCount( body );
                const completionTokens = proxy.countTokensFromContent( responsePayload?.choices?.[0]?.message?.content ?? '' );
                const normalizedResponse = responsePayload.usage
                    ? responsePayload
                    : {
                        ...responsePayload,
                        usage: {
                            prompt_tokens: promptTokens,
                            completion_tokens: completionTokens,
                            total_tokens: promptTokens + completionTokens,
                        },
                    };

                const anthropicResponse = proxy.convertOpenAIResponseToAnthropic( normalizedResponse, requestedModel );
                const responseWithToolSearch = proxy.attachAnthropicToolSearchUsage( anthropicResponse, hadToolSearchRequest );
                const responseWithWebSearch = proxy.webSearchHandler.attachAnthropicWebSearchMetadata( responseWithToolSearch, webSearchContext.searchResponse );
                const transformMs = Date.now() - transformStartedAt;
                const totalMs = Date.now() - requestStartedAt;
                const serverTiming = proxy.formatTimingEntries( {
                    body_parse: bodyParsedAt - requestStartedAt,
                    web_search: webSearchCompletedAt - requestStartedAt,
                    upstream: upstreamResponseReceivedAt - upstreamRequestStartedAt,
                    transform: transformMs,
                    total: totalMs,
                } );
                if ( serverTiming ) {
                    c.header( 'Server-Timing', serverTiming );
                }
                console.info( `[messages] success provider=${config.id} model=${selectedModel} bodyParseMs=${bodyParsedAt - requestStartedAt} webSearchMs=${webSearchCompletedAt - requestStartedAt} upstreamMs=${upstreamResponseReceivedAt - upstreamRequestStartedAt} transformMs=${transformMs} totalMs=${totalMs}` );
                proxy.providerStats.recordSuccess( config.id, selectedModel, upstreamResponseReceivedAt - upstreamRequestStartedAt );
                const finalPayload = proxy.attachUsageIfMissing( endpoint, body, responseWithWebSearch );
                if ( savedContainerId && finalPayload && typeof finalPayload === 'object' && !Array.isArray( finalPayload ) ) {
                    ( finalPayload as any ).container = { id: savedContainerId };
                }
                if ( body.stream === true ) {
                    const sseOut: string[] = [];
                    sseOut.push( `event: message\ndata: ${JSON.stringify( finalPayload )}\n\n` );
                    sseOut.push( `event: message_stop\ndata: ${JSON.stringify( { type: 'message_stop' } )}\n\n` );
                    c.header( 'Content-Type', 'text/event-stream; charset=utf-8' );
                    c.header( 'Cache-Control', 'no-cache, no-transform' );
                    c.header( 'X-Accel-Buffering', 'no' );
                    return c.text( sseOut.join( '' ) );
                }
                return c.json( finalPayload );
            } catch ( error: any ) {
                proxy.providerStats.recordFailure( config.id, selectedModel );
                lastFailure = {
                    status: 502,
                    payload: {
                        error: {
                            message: error?.message || 'Upstream request failed',
                            type: 'upstream_error',
                        },
                    },
                };
                console.error( `[${endpoint}] Exception from ${config?.id ?? config?.name}: ${error?.message || String( error )}` );
                continue;
            }
        }
    }

    if ( lastFailure ) {
        return handleLastFailure( c, lastFailure, body, backends, endpoint, requestedModel, requestStartedAt, bodyParsedAt, webSearchCompletedAt );
    }

    return handleAllProvidersFailed( c, body, backends, endpoint, requestedModel, requestStartedAt, bodyParsedAt, webSearchCompletedAt );
}

export async function handleMessagesBatches( _proxy: AnthropicProxy, c: Context ) {
    return c.json( { error: { message: 'Anthropic message batches are not supported for OpenAI-compatible backends', type: 'invalid_request_error' } }, 501 );
}
