import { Hono } from 'hono';
import type { Context } from 'hono';
import { randomBytes } from 'crypto';
import { stream } from 'hono/streaming';
import { rateLimitManager } from './RateLimitManager';
import { CONFIG } from '@/utils/schema.lookup';
import { fetchWithProxy } from '@/utils/proxyFetch';
import { stripFreeModifier } from '@/utils/modelIds';
import { getUnifiedModelCatalog } from '@/utils/modelCatalog';
import { formatTimingEntries } from '@/utils/timing';
import { convertAnthropicRequestToOpenAI, convertOpenAIResponseToAnthropic, relayUpstreamToStreamWriter } from './AnthropicOpenAIBridge';
import type { Config } from '@/schema';
import { webSearchHandler } from './WebSearchHandler';
import { codeInterpreterHandler } from './CodeInterpreterHandler';
import { backendCooldownManager } from './BackendCooldownManager';
import { ProviderStatsTracker } from './ProviderStatsTracker';
import { isDebugEnabled, redactForLog } from '@/utils/debug';
import { applySpoofHeaders } from '@/utils/spoofer';
import { resolveAnthropicBody, isSkillResolverReady } from './SkillResolver';
import { isStringContentOnlyProvider, normalizeMessagesContentToString } from './routing/shared';

type OpenAIModelConfig = NonNullable<Config['models']['openai']>[number];
type ReasoningEffort = NonNullable<OpenAIModelConfig['default_reasoning']>;
type Modality = OpenAIModelConfig['modalities']['input'][number];
const AUTO_MODEL_ID = 'auto';
const DEFAULT_MODALITIES: readonly Modality[] = ['text', 'image', 'audio', 'file'];
const MAX_SIBLING_MODELS_PER_PROVIDER = 4;  // Cap sibling-model substitution per provider in the last-resort pass

export class AnthropicProxy {
  private app: Hono;
  private webSearchHandler = webSearchHandler;
  private codeInterpreterHandler = codeInterpreterHandler;
  private readonly providerStats = new ProviderStatsTracker();
  private readonly backendRouteCache = new Map<string, OpenAIModelConfig[]>();
  private static readonly MAX_CACHE_SIZE = 1000;

  constructor() {
    this.app = new Hono();
    this.setupRoutes();
  }

  getApp(): Hono {
    return this.app;
  }

  private setupRoutes(): void {
    this.app.get( '/v1/models', ( c: Context ) => this.handleModels( c ) );
    this.app.post( '/v1/messages', ( c: Context ) => this.handleMessages( c ) );
    this.app.post( '/v1/messages/batches', ( c: Context ) => this.handleMessagesBatches( c ) );
    // ponytail: alias without /v1 — chatbot SDK posts to /anthropic/messages directly
    this.app.post( '/messages', ( c: Context ) => this.handleMessages( c ) );
  }

  private async handleModels( c: Context ) {
    try {
      const configs = CONFIG.models.openai;
      if ( !configs || !configs.length ) {
        console.error( '[/anthropic/v1/models] No OpenAI backend configured' );
        return c.json( { error: 'No OpenAI backend configured' }, 503 );
      }

      const catalog = await getUnifiedModelCatalog( CONFIG.proxy );
      return c.json( {
        object: 'list',
        data: catalog.data,
      } );
    } catch ( error: any ) {
      console.error( '[/anthropic/v1/models] Exception:', error?.message || String( error ) );
      return c.json( { error: 'Failed to fetch models' }, 500 );
    }
  }

  private async handleMessages( c: Context ) {
    const requestStartedAt = Date.now();
    const rawBody = await c.req.json().catch( () => ( {} ) );
    const bodyParsedAt = Date.now();

    // Resolve skill & file references before any processing
    // Save container.id for multi-turn passthrough (upstream does not support containers)
    const savedContainerId: string | undefined = rawBody?.container?.id;
    if ( isSkillResolverReady() ) {
      await resolveAnthropicBody( rawBody );
    }

    const webSearchContext = await this.webSearchHandler.prepareAnthropicWebSearch( rawBody );
    const webSearchCompletedAt = Date.now();
    if ( webSearchContext.errorResponse ) {
      return c.json( webSearchContext.errorResponse.body, webSearchContext.errorResponse.status as any );
    }

    const body = webSearchContext.body;
    const requestedModel = body.model;
    const requiredModalities = this.getRequiredModalities( body );
    const hadToolSearchRequest = this.hasAnthropicToolSearchRequest( body );
    let lastFailure: { status: number; payload: any } | null = null;

    if ( !requestedModel || typeof requestedModel !== 'string' ) {
      return c.json( {
        error: {
          message: 'Model is required and must be a string',
          type: 'invalid_request_error',
        },
      }, 400 );
    }

    if ( this.codeInterpreterHandler.shouldUseCodeInterpreter( body ) ) {
      try {
        const toolRunResult = await this.codeInterpreterHandler.executeToolLoop(
          body,
          this.getBackendConfigForModel( requestedModel ),
          requestedModel,
          async ( request: any ) => {
            const config = this.getBackendConfigForModel( requestedModel );
            const url = `${this.normalizeBaseUrl( config.baseUrl )}/chat/completions`;
            const upstreamRequest = this.withReasoningEffort( request, body, config, request?.model ?? requestedModel );
            const upstreamRequestStartedAt = Date.now();
            const response = await fetchWithProxy( url, {
              method: 'POST',
              headers: this.buildHeaders( config ),
              body: JSON.stringify( upstreamRequest ),
            }, CONFIG.proxy );
            const upstreamResponseReceivedAt = Date.now();
            const payload = await this.parseResponsePayload( response );
            if ( !response.ok ) {
              const error = new Error( `Upstream request failed with ${response.status}` );
              ( error as any ).status = response.status;
              ( error as any ).payload = payload;
              throw error;
            }
            console.info( `[messages] code_interpreter_upstream provider=${config.id} model=${requestedModel} upstreamMs=${upstreamResponseReceivedAt - upstreamRequestStartedAt} totalMs=${upstreamResponseReceivedAt - requestStartedAt}` );
            return { response, payload };
          },
          this.calculateTokenCount.bind( this ),
          rateLimitManager,
          this.buildCodeInterpreterSessionId()
        );
        const totalMs = Date.now() - requestStartedAt;
        const serverTiming = formatTimingEntries( {
          body_parse: bodyParsedAt - requestStartedAt,
          web_search: webSearchCompletedAt - requestStartedAt,
          total: totalMs,
        } );
        if ( serverTiming ) {
          c.header( 'Server-Timing', serverTiming );
        }
        console.info( `[messages] success provider=code_interpreter model=${requestedModel} bodyParseMs=${bodyParsedAt - requestStartedAt} webSearchMs=${webSearchCompletedAt - requestStartedAt} totalMs=${totalMs}` );
        return c.json( toolRunResult.payload, 200 );
      } catch ( error: any ) {
        lastFailure = {
          status: error?.status ?? 502,
          payload: error?.payload ?? {
            error: {
              message: error?.message || 'Upstream request failed',
              type: 'invalid_request_error',
            },
          },
        };
      }
    }

    const endpoint = 'messages';
    const matchingBackends = this.getBackendsForModel( requestedModel, requiredModalities );
    if ( !matchingBackends.length ) {
      console.error( `[${endpoint}] No OpenAI backends found for model: ${requestedModel}` );
      return c.json( {
        error: {
          message: `Model not found: ${requestedModel}`,
          type: 'invalid_request_error',
        },
      }, 400 );
    }

    const backends = this.getOptimizedBackends( requestedModel, matchingBackends, requiredModalities );

    const backendIds = backends.map( b => b.id ).join( ', ' );
    console.error( `[${endpoint}] Attempting OpenAI backends for model ${requestedModel}: ${backendIds}` );

    // Two-pass attempt plan (see OpenAIProxy.proxyRequest): the exact requested
    // model first, then sibling models from random-routing participants in the
    // same group as the last-resort pass.
    const attempts: { config: OpenAIModelConfig; selectedModel: string }[] = [];
    for ( const config of backends ) {
      const candidateModels = this.getCandidateModelsForProvider( config, requestedModel, requiredModalities );
      for ( const selectedModel of candidateModels ) {
        attempts.push( { config, selectedModel } );
      }
    }
    const isAutoEdgeRequest = this.isAutoModel( requestedModel )
      || !( CONFIG.models.openai ?? [] ).some( c => this.configHasModel( c, requestedModel ) );
    let attemptIdx = 0;
    let siblingPassAppended = false;

    while ( true ) {
      if ( attemptIdx >= attempts.length ) {
        if ( !siblingPassAppended && !isAutoEdgeRequest ) {
          siblingPassAppended = true;
          console.error( `[${endpoint}] In-group backends exhausted for ${requestedModel} — sibling pass (random-routing participants)` );
          for ( const config of backends ) {
            const siblings = this.getCandidateModelsForProvider( config, requestedModel, requiredModalities, true );
            for ( const siblingModel of siblings ) {
              attempts.push( { config, selectedModel: siblingModel } );
            }
          }
        } else {
          break;
        }
      }
      if ( attemptIdx >= attempts.length ) break;
      const { config, selectedModel } = attempts[attemptIdx]!;
      attemptIdx++;
      const cooldownRemainingMs = backendCooldownManager.getRemainingMs( config.id, selectedModel );
        if ( cooldownRemainingMs > 0 ) {
          console.warn( `[${endpoint}] cooldown_active provider=${config.id} model=${selectedModel} remainingMs=${cooldownRemainingMs}` );
          continue;
        }

        const tokens = this.calculateTokenCount( body );
        const rateLimit = this.getEffectiveRateLimit( config, selectedModel );
        // ── Preemptive TPM-meter hop (see OpenAIProxy.proxyRequest) ──
        if ( this.isGeminiProvider( config ) && rateLimit ) {
          const meterRemaining = await rateLimitManager.peekRemaining( config.id, rateLimit, selectedModel );
          if ( meterRemaining !== null && meterRemaining < tokens ) {
            console.error( `[${endpoint}] TPM meter low provider=${config.id} model=${selectedModel} remaining=${meterRemaining} need=${tokens} — preemptive hop` );
            continue;
          }
        }
        const rateCheck = await rateLimitManager.checkAndConsume(
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
          const convertedRequest = convertAnthropicRequestToOpenAI( body, selectedModel, 'native' );
          const withReasoning = this.withReasoningEffort( convertedRequest, body, config, selectedModel );
          const openAIRequestRaw = this.isGeminiProvider( config )
            ? this.ensureToolCallThoughtSignatures( withReasoning )
            : withReasoning;
          const openAIRequest = isStringContentOnlyProvider( config )
            ? normalizeMessagesContentToString( openAIRequestRaw )
            : openAIRequestRaw;
          const upstreamEndpoint = this.getOpenAIEndpointForAnthropicEndpoint( endpoint );
          const url = `${this.normalizeBaseUrl( config.baseUrl )}/${upstreamEndpoint}`;
          const upstreamRequestStartedAt = Date.now();
          if ( isDebugEnabled() ) {
            console.info( `[messages] upstream_request model=${selectedModel} body=${JSON.stringify( redactForLog( openAIRequest ) )}` );
          }

          // Fetch upstream OUTSIDE of stream() to avoid ReadableStream conflicts
          const response = await fetchWithProxy( url, {
            method: 'POST',
            headers: this.buildHeaders( config, openAIRequest.stream === true ),
            body: JSON.stringify( openAIRequest ),
          }, CONFIG.proxy, { skipTimeout: openAIRequest.stream === true } );
          const upstreamResponseReceivedAt = Date.now();

          backendCooldownManager.markFromStatus( config.id, selectedModel, response.status );
          if ( response.status === 429 ) {
            this.providerStats.recordFailure( config.id, selectedModel, upstreamResponseReceivedAt - upstreamRequestStartedAt );
            continue;
          }

          const contentType = response.headers.get( 'content-type' ) ?? '';
          if ( openAIRequest.stream === true && response.ok && response.body && contentType.includes( 'text/event-stream' ) ) {
            const serverTiming = formatTimingEntries( {
              body_parse: bodyParsedAt - requestStartedAt,
              web_search: webSearchCompletedAt - requestStartedAt,
              upstream: upstreamResponseReceivedAt - upstreamRequestStartedAt,
              total: upstreamResponseReceivedAt - upstreamRequestStartedAt,
            } );
            if ( serverTiming ) {
              c.header( 'Server-Timing', serverTiming );
            }
            console.info( `[messages] stream_started provider=${config.id} model=${selectedModel} setupMs=${Date.now() - requestStartedAt} bodyParseMs=${bodyParsedAt - requestStartedAt} webSearchMs=${webSearchCompletedAt - requestStartedAt} upstreamMs=${upstreamResponseReceivedAt - upstreamRequestStartedAt}` );
            this.providerStats.recordSuccess( config.id, selectedModel, upstreamResponseReceivedAt - upstreamRequestStartedAt );
            backendCooldownManager.recordSuccess( config.id );

            // Now enter stream() with the already-fetched response
            c.header( 'Content-Type', 'text/event-stream; charset=utf-8' );
            c.header( 'Transfer-Encoding', 'chunked' );
            c.header( 'Cache-Control', 'no-cache, no-transform' );
            c.header( 'Connection', 'keep-alive' );
            c.header( 'X-Accel-Buffering', 'no' );
            return stream( c, async ( streamWriter ) => {
              await relayUpstreamToStreamWriter(
                c,
                response,
                requestedModel,
                streamWriter,
                webSearchContext.searchResponse ? this.buildAnthropicWebSearchBlocks( webSearchContext.searchResponse ) : undefined,
                requestStartedAt
              );
            } );
          }

          const transformStartedAt = Date.now();
          const payload = await this.parseResponsePayload( response );
          if ( isDebugEnabled() ) {
            console.info( `[messages] upstream_response model=${selectedModel} status=${response.status} body=${JSON.stringify( redactForLog( payload ) )}` );
          }

          if ( !response.ok ) {
            lastFailure = {
              status: response.status,
              payload,
            };
            this.providerStats.recordFailure( config.id, selectedModel, upstreamResponseReceivedAt - upstreamRequestStartedAt );
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
          const promptTokens = this.calculateTokenCount( body );
          const completionTokens = this.countTokensFromContent( responsePayload?.choices?.[0]?.message?.content ?? '' );
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

          const anthropicResponse = convertOpenAIResponseToAnthropic( normalizedResponse, requestedModel );
          const responseWithToolSearch = this.attachAnthropicToolSearchUsage( anthropicResponse, hadToolSearchRequest );
          const responseWithWebSearch = this.webSearchHandler.attachAnthropicWebSearchMetadata( responseWithToolSearch, webSearchContext.searchResponse );
          const transformMs = Date.now() - transformStartedAt;
          const totalMs = Date.now() - requestStartedAt;
          const serverTiming = formatTimingEntries( {
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
          this.providerStats.recordSuccess( config.id, selectedModel, upstreamResponseReceivedAt - upstreamRequestStartedAt );
          backendCooldownManager.recordSuccess( config.id );
          const finalPayload = this.attachUsageIfMissing( endpoint, body, responseWithWebSearch );
          // Multi-turn container passthrough: inject saved container.id so client can continue
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
          this.providerStats.recordFailure( config.id, selectedModel );
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

    if ( lastFailure ) {
      const errorPayload = typeof lastFailure.payload === 'object' ? JSON.stringify( lastFailure.payload ) : String( lastFailure.payload );
      console.error( `\n❌ [${endpoint}] FINAL FAILURE (${lastFailure.status})\nAttempted backends: ${backends.map( b => b.id ).join( ', ' )}\nError: ${errorPayload}\n` );
      console.info( `[messages] failed totalMs=${Date.now() - requestStartedAt} bodyParseMs=${bodyParsedAt - requestStartedAt} webSearchMs=${webSearchCompletedAt - requestStartedAt}` );
      const errPayload = { type: 'error', error: { type: 'api_error', message: typeof lastFailure.payload === 'object' && lastFailure.payload?.error?.message ? lastFailure.payload.error.message : 'Upstream request failed' } };
      if ( body.stream === true ) {
        const errSse: string[] = [];
        errSse.push( `event: error\ndata: ${JSON.stringify( errPayload )}\n\n` );
        errSse.push( `event: message_stop\ndata: ${JSON.stringify( { type: 'message_stop' } )}\n\n` );
        c.header( 'Content-Type', 'text/event-stream; charset=utf-8' );
        c.header( 'Cache-Control', 'no-cache, no-transform' );
        return c.text( errSse.join( '' ) );
      }
      return c.json( errPayload, lastFailure.status as any );
    }

    console.error( `\n❌ [${endpoint}] ALL OPENAI PROVIDERS FAILED - No response from any backend\nModel: ${requestedModel}\nAttempted: ${backends.map( b => b.id ).join( ', ' )}\n` );
    console.info( `[messages] failed totalMs=${Date.now() - requestStartedAt} bodyParseMs=${bodyParsedAt - requestStartedAt} webSearchMs=${webSearchCompletedAt - requestStartedAt}` );
    const errPayload = { type: 'error', error: { type: 'internal_error', message: 'All providers failed' } };
    if ( body.stream === true ) {
      const errSse: string[] = [];
      errSse.push( `event: error\ndata: ${JSON.stringify( errPayload )}\n\n` );
      errSse.push( `event: message_stop\ndata: ${JSON.stringify( { type: 'message_stop' } )}\n\n` );
      c.header( 'Content-Type', 'text/event-stream; charset=utf-8' );
      c.header( 'Cache-Control', 'no-cache, no-transform' );
      return c.text( errSse.join( '' ) );
    }
    return c.json( errPayload, 502 );
  }

  private async handleMessagesBatches( c: Context ) {
    return c.json(
      {
        error: {
          message: 'Anthropic message batches are not supported for OpenAI-compatible backends',
          type: 'invalid_request_error',
        },
      },
      501
    );
  }

  private hasAnthropicToolSearchRequest( body: any ): boolean {
    const tools = Array.isArray( body?.tools ) ? body.tools : [];
    return tools.some( ( tool: any ) =>
      ( typeof tool?.type === 'string' && /^tool_search_tool_(regex|bm25)_\d+$/.test( tool.type ) )
      || ( typeof tool?.name === 'string' && /^(tool_search_tool_regex|tool_search_tool_bm25)$/.test( tool.name ) )
    );
  }

  private attachAnthropicToolSearchUsage( payload: any, enabled: boolean ): any {
    if ( !enabled || !payload || typeof payload !== 'object' || Array.isArray( payload ) ) {
      return payload;
    }

    const usage = payload.usage && typeof payload.usage === 'object' ? payload.usage : {};
    const serverToolUse = usage.server_tool_use && typeof usage.server_tool_use === 'object' ? usage.server_tool_use : {};

    return {
      ...payload,
      usage: {
        ...usage,
        server_tool_use: {
          ...serverToolUse,
          tool_search_requests: ( serverToolUse.tool_search_requests ?? 0 ) + 1,
        },
      },
    };
  }

  private getBackendsForModel( modelName: string, requiredModalities: readonly Modality[] = ['text'], targetGroup?: string ): OpenAIModelConfig[] {
    const effectiveGroup = targetGroup || 'default';
    const cacheKey = this.buildRouteCacheKey( modelName, requiredModalities ) + `|${effectiveGroup}`;
    const cached = this.backendRouteCache.get( cacheKey );
    if ( cached ) {
      return cached;
    }

    const configs = CONFIG.models.openai || [];
    const explicitlyAuto = this.isAutoModel( modelName );
    const modelIsListed = configs.some( config =>
      this.configHasModel( config, modelName )
    );
    // Unlisted models are treated as auto-edge: route through all available backends.
    const isAutoModel = explicitlyAuto || !modelIsListed;

    const exactBackends: OpenAIModelConfig[] = [];
    const fallbackBackends: OpenAIModelConfig[] = [];

    for ( const config of configs ) {
      // Skip STT/TTS/embeddings/image providers for chat/messages routing
      if (
        this.isSttOrTtsOnlyConfig( config )
        || this.isEmbeddingsEnabled( config )
        || this.isImageOnlyConfig( config )
        || !this.providerSupportsModalities( config, requiredModalities )
      ) {
        continue;
      }

      const matchesRequestedModel = this.configHasModel( config, modelName );

      // Group isolation: only applies to auto-edge (fallback) routing.
      // Explicit model requests always gather all providers regardless of group.
      if ( isAutoModel && ( config as any ).groupSpace !== effectiveGroup ) continue;

      if ( matchesRequestedModel ) {
        exactBackends.push( config );
      } else if ( isAutoModel || config.randomRouting !== false ) {
        fallbackBackends.push( config );
      }
    }

    const result = isAutoModel
      ? fallbackBackends
      : modelIsListed
        ? [
            ...exactBackends,
            // Fallback stays group-scoped: only fall back to providers in the
            // same groupSpace as an exact-match provider.
            ...fallbackBackends.filter( ( fb ) => {
              const fbGroup = ( fb as any ).groupSpace || 'default';
              return exactBackends.some( ( eb ) => ( ( eb as any ).groupSpace || 'default' ) === fbGroup );
            } ),
          ]
        : fallbackBackends;
    this.backendRouteCache.set( cacheKey, result );
    return result;
  }

  private isAutoModel( modelName: string ): boolean {
    return stripFreeModifier( modelName ).normalizedId === AUTO_MODEL_ID;
  }

  private configHasModel( config: OpenAIModelConfig, modelName: string ): boolean {
    const requestedNormalized = stripFreeModifier( modelName ).normalizedId;
    return config.models.some( m => {
      const candidate = typeof m === 'string' ? m : ( m as any ).model;
      return stripFreeModifier( candidate ).normalizedId === requestedNormalized;
    } );
  }

  private isEmbeddingsEnabled( config: OpenAIModelConfig ): boolean {
    return config.embeddings === true;
  }

  private isSttOrTtsOnlyConfig( config: OpenAIModelConfig ): boolean {
    return config.stt === true || config.tts === true;
  }

  /** image_generation / image_editing providers must never serve text messages. */
  private isImageOnlyConfig( config: OpenAIModelConfig ): boolean {
    const imageModels = ( config as any ).imageModels;
    if ( typeof imageModels === 'boolean' ) {
      return imageModels;
    }
    if ( typeof imageModels !== 'object' || !imageModels ) {
      return false;
    }
    return imageModels.image_generation === true || imageModels.image_editing === true;
  }

  private isGeminiProvider( config: OpenAIModelConfig ): boolean {
    const baseUrl = ( config.baseUrl || '' ).toLowerCase();
    const id = ( config.id || '' ).toLowerCase();
    const name = ( config.name || '' ).toLowerCase();
    return baseUrl.includes( 'gemini' ) || baseUrl.includes( 'google' )
      || id.includes( 'gemini' ) || id.includes( 'google' )
      || name.includes( 'gemini' ) || name.includes( 'google' );
  }

  private getBackendConfigForModel( modelName: string ): OpenAIModelConfig {
    const configs = CONFIG.models.openai;
    if ( !configs || !configs.length ) {
      throw new Error( 'No OpenAI backend configured' );
    }

    const matchingBackends = this.getBackendsForModel( modelName );
    if ( !matchingBackends.length ) {
      throw new Error( `Model not found: ${modelName}` );
    }

    return this.getRoundRobinBackends( modelName, matchingBackends )[0]!;
  }

  private getOpenAIEndpointForAnthropicEndpoint( endpoint: string ): string {
    if ( endpoint === 'messages' ) {
      return 'chat/completions';
    }
    throw new Error( `Unsupported Anthropic endpoint mapping: ${endpoint}` );
  }

  private getRoundRobinBackends( modelName: string, backends: OpenAIModelConfig[] ): OpenAIModelConfig[] {
    if ( backends.length <= 1 ) {
      return backends;
    }

    const key = `anthropic:model:${modelName}`;
    const startIndex = this.getAndIncrementRoundRobinIndex( key, backends.length );
    return [...backends.slice( startIndex ), ...backends.slice( 0, startIndex )];
  }

  private getAndIncrementRoundRobinIndex( key: string, total: number ): number {
    if ( total <= 0 ) {
      return 0;
    }

    const current = this.rrIndexByKey.get( key ) ?? 0;
    const index = current % total;
    this.rrIndexByKey.set( key, ( index + 1 ) % total );
    return index;
  }

  private buildHeaders( config: OpenAIModelConfig, stream = false ): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
      'User-Agent': 'ai-edge/1.0',
    };

    if ( stream ) {
      headers.Accept = 'text/event-stream';
      headers['Accept-Encoding'] = 'identity';
      headers.Connection = 'keep-alive';
      headers['Cache-Control'] = 'no-cache';
    }

    if ( CONFIG.spoofer === true ) {
      return applySpoofHeaders( headers );
    }

    return headers;
  }

  private getOptimizedBackends( modelName: string, backends: OpenAIModelConfig[], requiredModalities: readonly Modality[] ): OpenAIModelConfig[] {
    const candidates = this.getRoundRobinBackends( this.buildRouteCacheKey( modelName, requiredModalities ), backends );
    const sorted = candidates.sort( ( left, right ) => this.scoreProvider( right, modelName, requiredModalities ) - this.scoreProvider( left, modelName, requiredModalities ) );

    // Group isolation: fallback must stay within the primary backend's groupSpace.
    const primaryBackend = sorted[0];
    return primaryBackend
      ? sorted.filter( ( b ) => ( ( b as any ).groupSpace || 'default' ) === ( ( primaryBackend as any ).groupSpace || 'default' ) )
      : sorted;
  }

  private scoreProvider( config: OpenAIModelConfig, requestedModel: string, requiredModalities: readonly Modality[] ): number {
    // Provider-level health gate: heavily penalize providers on cooldown
    if ( backendCooldownManager.getProviderHealthScore( config.id ) < 50 ) {
      return -1000;
    }

    const candidateModels = this.getCandidateModelsForProvider( config, requestedModel, requiredModalities );
    if ( candidateModels.length === 0 ) {
      return -500; // No healthy models available from this provider
    }
    const modelName = candidateModels[0] ?? requestedModel;
    const stats = this.providerStats.getStats( config.id, modelName );

    const exactScore = this.configHasModel( config, requestedModel ) ? 1 : 0;
    const successScore = ( stats?.successRateEwma ?? 1 ) * 40;
    const latencyScore = stats?.latencyEwmaMs ? Math.max( 0, 1 - stats.latencyEwmaMs / 30000 ) * 20 : 10;
    const failurePenalty = Math.min( 50, ( stats?.consecutiveFailures ?? 0 ) * 8 );
    const healthScore = backendCooldownManager.getProviderHealthScore( config.id );
    const freshnessBonus = Math.max( 0, 5 - ( stats ? ( Date.now() - stats.lastUpdatedAt ) / 60000 : 5 ) );

    return exactScore * 100 + successScore + latencyScore + healthScore / 2 + freshnessBonus - failurePenalty;
  }

  private getCandidateModelsForProvider( config: OpenAIModelConfig, requestedModel: string, requiredModalities: readonly Modality[] = ['text'], includeSiblings = false ): string[] {
    // Provider-level health gate: skip entire provider if it is unhealthy
    if ( backendCooldownManager.getProviderHealthScore( config.id ) < 50 ) {
      return [];
    }

    const explicitlyAuto = this.isAutoModel( requestedModel );
    const modelInThisProvider = config.models.some( m => {
      const candidate = typeof m === 'string' ? m : ( m as any ).model;
      return stripFreeModifier( candidate ).normalizedId === stripFreeModifier( requestedModel ).normalizedId;
    } );
    // Unlisted models treated as auto-edge: pick best model from provider.
    const isAutoModel = explicitlyAuto || !modelInThisProvider;

    if ( config.randomRouting === false && !isAutoModel && this.modelSupportsModalities( config, requestedModel, requiredModalities ) ) {
      // Still apply health filter for non-random routing
      if ( !backendCooldownManager.isOnCooldown( config.id, requestedModel ) ) {
        const stats = this.providerStats.getStats( config.id, requestedModel );
        if ( !stats || stats.consecutiveFailures < 5 ) {
          return [requestedModel];
        }
      }
      // Fall through to try other models if requested model is unhealthy
    }

    const modelNames = config.models
      .filter( model => this.modelEntrySupportsModalities( config, model, requiredModalities ) )
      .map( m => ( typeof m === 'string' ? m : ( m as any ).model ) );
    const uniqueModels: string[] = Array.from( new Set( modelNames ) );

    if ( !isAutoModel ) {
      // Sibling pass (last resort): when the requested model is exhausted
      // across the whole group, participating (randomRouting !== false)
      // providers offer their other models — the return benefit of taking
      // part in random routing.
      if ( includeSiblings && config.randomRouting !== false ) {
        const siblingModels = uniqueModels.filter( m => m !== requestedModel );
        if ( !siblingModels.length ) return [];
        const healthySiblings = siblingModels.filter( model => {
          if ( backendCooldownManager.isOnCooldown( config.id, model ) ) return false;
          const stats = this.providerStats.getStats( config.id, model );
          return !( stats && stats.consecutiveFailures >= 5 );
        } );
        const pool = healthySiblings.length > 0 ? healthySiblings : siblingModels;
        const startIndex = Math.floor( Math.random() * pool.length );
        return [...pool.slice( startIndex ), ...pool.slice( 0, startIndex )].slice( 0, MAX_SIBLING_MODELS_PER_PROVIDER );
      }
      return [requestedModel];
    }
    if ( !uniqueModels.length ) {
      return [requestedModel];
    }

    // Filter out unhealthy models (on cooldown or with too many consecutive failures)
    const healthyModels = uniqueModels.filter( model => {
      if ( backendCooldownManager.isOnCooldown( config.id, model ) ) {
        return false;
      }
      const stats = this.providerStats.getStats( config.id, model );
      if ( stats && stats.consecutiveFailures >= 5 ) {
        return false;
      }
      return true;
    } );

    const modelsToUse = healthyModels.length > 0 ? healthyModels : uniqueModels;

    const startIndex = Math.floor( Math.random() * modelsToUse.length );
    return [...modelsToUse.slice( startIndex ), ...modelsToUse.slice( 0, startIndex )];
  }

  private getRequiredModalities( body: any ): Modality[] {
    const modalities = new Set<Modality>( ['text'] );

    for ( const message of Array.isArray( body?.messages ) ? body.messages : [] ) {
      const content = message?.content;
      if ( !Array.isArray( content ) ) {
        continue;
      }

      for ( const block of content ) {
        if ( block?.type === 'image' || block?.type === 'image_url' ) {
          modalities.add( 'image' );
        } else if ( block?.type === 'audio' || block?.type === 'input_audio' ) {
          modalities.add( 'audio' );
        } else if ( block?.type === 'file' || block?.type === 'input_file' ) {
          modalities.add( 'file' );
        }
      }
    }

    return Array.from( modalities );
  }

  private providerSupportsModalities( config: OpenAIModelConfig, requiredModalities: readonly Modality[] ): boolean {
    const providerModalities = new Set( config.modalities?.input ?? DEFAULT_MODALITIES );
    return requiredModalities.every( modality => providerModalities.has( modality ) )
      || config.models.some( model => this.modelEntrySupportsModalities( config, model, requiredModalities ) );
  }

  private modelSupportsModalities( config: OpenAIModelConfig, modelName: string, requiredModalities: readonly Modality[] ): boolean {
    const modelEntry = config.models.find( model => {
      const candidate = typeof model === 'string' ? model : model.model;
      return stripFreeModifier( candidate ).normalizedId === stripFreeModifier( modelName ).normalizedId;
    } );
    return modelEntry ? this.modelEntrySupportsModalities( config, modelEntry, requiredModalities ) : this.providerSupportsModalities( config, requiredModalities );
  }

  private modelEntrySupportsModalities( config: OpenAIModelConfig, model: OpenAIModelConfig['models'][number], requiredModalities: readonly Modality[] ): boolean {
    const modalities = new Set( typeof model === 'object'
      ? ( model.modalities?.input ?? config.modalities?.input ?? DEFAULT_MODALITIES )
      : ( config.modalities?.input ?? DEFAULT_MODALITIES ) );
    return requiredModalities.every( modality => modalities.has( modality ) );
  }

  private buildRouteCacheKey( modelName: string, requiredModalities: readonly Modality[] ): string {
    return `${stripFreeModifier( modelName ).normalizedId}|${[...requiredModalities].sort().join( ',' )}`;
  }

  private withReasoningEffort( openAIRequest: any, sourceBody: any, config: OpenAIModelConfig, selectedModel: string ): any {
    if ( !this.isReasoningConfiguredForModel( config, selectedModel ) ) {
      return this.stripReasoningFields( openAIRequest );
    }

    if ( !this.hasExplicitReasoningRequest( sourceBody ) ) {
      return openAIRequest;
    }

    const effort = this.resolveReasoningEffort( sourceBody, config, selectedModel );
    if ( !effort || effort === 'none' ) {
      return openAIRequest;
    }

    return {
      ...openAIRequest,
      reasoning_effort: effort,
    };
  }

  private hasExplicitReasoningRequest( body: any ): boolean {
    return typeof body?.reasoning_effort === 'string'
      || typeof body?.reasoning?.effort === 'string'
      || typeof body?.thinking?.effort === 'string'
      || body?.include_reasoning === true
      || body?.output_reasoning === true;
  }

  private resolveReasoningEffort( body: any, config: OpenAIModelConfig, selectedModel: string ): ReasoningEffort | undefined {
    if ( !this.isReasoningConfiguredForModel( config, selectedModel ) ) {
      return undefined;
    }

    if ( typeof body?.reasoning_effort === 'string' ) {
      return body.reasoning_effort as ReasoningEffort;
    }

    if ( typeof body?.reasoning?.effort === 'string' ) {
      return body.reasoning.effort as ReasoningEffort;
    }

    if ( typeof body?.thinking?.effort === 'string' ) {
      return body.thinking.effort as ReasoningEffort;
    }

    const modelEntry = config.models.find( model => {
      const modelName = typeof model === 'string' ? model : model.model;
      return stripFreeModifier( modelName ).normalizedId === stripFreeModifier( selectedModel ).normalizedId;
    } );

    if ( modelEntry && typeof modelEntry === 'object' && modelEntry.default_reasoning ) {
      return modelEntry.default_reasoning;
    }

    return config.default_reasoning;
  }

  private isReasoningConfiguredForModel( config: OpenAIModelConfig, selectedModel: string ): boolean {
    const hasProviderReasoning = Object.prototype.hasOwnProperty.call( config, 'reasoning_efforts' )
      || Object.prototype.hasOwnProperty.call( config, 'default_reasoning' );
    if ( hasProviderReasoning ) {
      return true;
    }

    const modelEntry = config.models.find( model => {
      const modelName = typeof model === 'string' ? model : model.model;
      return stripFreeModifier( modelName ).normalizedId === stripFreeModifier( selectedModel ).normalizedId;
    } );

    return !!modelEntry
      && typeof modelEntry === 'object'
      && ( Object.prototype.hasOwnProperty.call( modelEntry, 'reasoning_efforts' )
        || Object.prototype.hasOwnProperty.call( modelEntry, 'default_reasoning' ) );
  }

  private stripReasoningFields( body: any ): any {
    if ( !body || typeof body !== 'object' ) {
      return body;
    }
    const { reasoning_effort, reasoning, thinking, include_reasoning, output_reasoning, ...rest } = body;
    return rest;
  }

  private getEffectiveRateLimit( config: OpenAIModelConfig, selectedModel?: string ): Config['rateLimit'] | undefined {
    // Per-model rate limit (models array entries can carry their own
    // rateLimit — the gemini providers use this) takes precedence.
    if ( selectedModel ) {
      const entry = config.models.find( m =>
        typeof m !== 'string' && ( m as any ).model === selectedModel && ( m as any ).rateLimit
      );
      if ( entry && typeof entry !== 'string' ) {
        return ( entry as any ).rateLimit;
      }
    }
    if ( config.individualLimit && config.rateLimit ) {
      return config.rateLimit;
    }
    return CONFIG.rateLimit;
  }

  private async parseResponsePayload( response: Response ): Promise<any> {
    const contentType = response.headers.get( 'content-type' ) ?? '';

    if ( contentType.includes( 'application/json' ) ) {
      return response.json().catch( () => ( {
        error: {
          message: 'Upstream returned invalid JSON',
          type: 'upstream_error',
        },
      } ) );
    }

    const text = await response.text().catch( () => '' );
    if ( !text ) {
      return {
        error: {
          message: response.statusText || 'Upstream request failed',
          type: 'upstream_error',
        },
      };
    }

    return text;
  }

  private sendFailurePayload( c: Context, status: number, payload: any ) {
    if ( payload && typeof payload === 'object' ) {
      return c.json( payload, status as any );
    }
    return c.text( String( payload ?? 'Upstream request failed' ), status as any );
  }

  private normalizeBaseUrl( baseUrl: string ): string {
    return baseUrl.replace( /\/+$/, '' );
  }

  private calculateTokenCount( body: any ): number {
    if ( !body ) return 0;

    let totalTokens = 0;

    if ( body.messages && Array.isArray( body.messages ) ) {
      for ( const msg of body.messages ) {
        totalTokens += this.countTokensFromContent( msg.content );
        if ( msg.tool_calls ) {
          for ( const tool of msg.tool_calls ) {
            totalTokens += Math.max( 1, Math.ceil( JSON.stringify( tool.function.arguments ).length / 4 ) );
          }
        }
      }
    }

    if ( body.system ) {
      totalTokens += this.countTokensFromContent( body.system );
    }

    if ( totalTokens === 0 ) {
      totalTokens = 100;
    }

    return totalTokens;
  }

  private countTokensFromContent( content: any ): number {
    if ( typeof content === 'string' ) {
      return Math.max( 1, Math.ceil( content.length / 4 ) );
    }
    if ( Array.isArray( content ) ) {
      return content.reduce( ( sum: number, block: any ) => {
        if ( block.type === 'text' && block.text ) {
          return sum + Math.max( 1, Math.ceil( block.text.length / 4 ) );
        }
        return sum;
      }, 0 );
    }
    return 0;
  }

  private attachUsageIfMissing( endpoint: string, requestBody: any, responseData: any ): any {
    if ( !responseData || typeof responseData !== 'object' || Array.isArray( responseData ) ) {
      return responseData;
    }

    if ( responseData.usage ) {
      return responseData;
    }

    const promptTokens = this.calculateTokenCount( requestBody );
    const completionTokens = this.countTokensFromContent( responseData.content || responseData.output || '' );

    return {
      ...responseData,
      usage: {
        input_tokens: promptTokens,
        output_tokens: completionTokens,
      },
    };
  }

  private ensureToolCallThoughtSignatures( body: any ): any {
    if ( !body || typeof body !== 'object' ) {
      return body;
    }

    if ( !Array.isArray( body.messages ) ) {
      return body;
    }

    const FALLBACK_SIG = 'skip_thought_signature_validator';

    let changed = false;
    const messages = body.messages.map( ( message: any ) => {
      if ( !message || !Array.isArray( message.tool_calls ) ) {
        return message;
      }

      const toolCalls = message.tool_calls.map( ( toolCall: any ) => {
        if ( !toolCall || typeof toolCall !== 'object' ) {
          return toolCall;
        }

        // Gemini API expects thought_signature in extra_content.google.thought_signature
        const existingSig = toolCall.extra_content?.google?.thought_signature
          || toolCall.thought_signature
          || toolCall.function?.thought_signature;

        if ( existingSig ) {
          if ( toolCall.extra_content?.google?.thought_signature && toolCall.function?.thought_signature ) {
            return toolCall;
          }
          changed = true;
          return {
            ...toolCall,
            thought_signature: existingSig,
            function: {
              ...( toolCall.function || {} ),
              thought_signature: existingSig,
            },
            extra_content: {
              ...( toolCall.extra_content || {} ),
              google: {
                ...( toolCall.extra_content?.google || {} ),
                thought_signature: existingSig,
              },
            },
          };
        }

        changed = true;
        return {
          ...toolCall,
          thought_signature: FALLBACK_SIG,
          function: {
            ...( toolCall.function || {} ),
            thought_signature: FALLBACK_SIG,
          },
          extra_content: {
            ...( toolCall.extra_content || {} ),
            google: {
              ...( toolCall.extra_content?.google || {} ),
              thought_signature: FALLBACK_SIG,
            },
          },
        };
      } );

      if ( toolCalls === message.tool_calls ) {
        return message;
      }

      return {
        ...message,
        tool_calls: toolCalls,
      };
    } );

    if ( !changed ) {
      return body;
    }

    return {
      ...body,
      messages,
    };
  }

  private buildCodeInterpreterSessionId(): string {
    return `ci_${Date.now().toString( 36 )}_${Math.random().toString( 36 ).slice( 2, 8 )}`;
  }

  private buildAnthropicWebSearchBlocks( searchResponse: any ): any[] {
    const toolUseId = `srvtoolu_${Date.now().toString( 36 )}`;
    const toolResultContent = searchResponse.citations.map( ( citation: any ) => ( {
      type: 'web_search_result',
      url: citation.url,
      title: citation.title,
      encrypted_content: this.buildWebSearchEncryptedContent( citation.title, citation.url, citation.snippet ),
    } ) );

    return [
      {
        type: 'server_tool_use',
        id: toolUseId,
        name: 'web_search',
        input: { query: searchResponse.query },
      },
      {
        type: 'web_search_tool_result',
        tool_use_id: toolUseId,
        content: toolResultContent,
      },
    ];
  }

  private buildWebSearchEncryptedContent( title: string, url: string, snippet: string ): string {
    return Buffer.from( JSON.stringify( { title, url, snippet } ) ).toString( 'base64' );
  }

  private readonly rrIndexByKey = new Map<string, number>();
}

export const anthropicProxy = new AnthropicProxy();
