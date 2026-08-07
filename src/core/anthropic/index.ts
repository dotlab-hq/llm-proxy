import { Hono } from 'hono';
import type { Context } from 'hono';
import { rateLimitManager } from '../RateLimitManager';
import { CONFIG } from '@/utils/schema.lookup';
import { fetchWithProxy } from '@/utils/proxyFetch';
import { getUnifiedModelCatalog } from '@/utils/modelCatalog';
import { formatTimingEntries } from '@/utils/timing';
import { convertAnthropicRequestToOpenAI, convertOpenAIResponseToAnthropic, relayUpstreamToStreamWriter } from '../AnthropicOpenAIBridge';
import type { Config } from '@/schema';
import { webSearchHandler } from '../WebSearchHandler';
import { codeInterpreterHandler } from '../CodeInterpreterHandler';
import { backendCooldownManager } from '../BackendCooldownManager';
import { ProviderStatsTracker } from '../ProviderStatsTracker';
import { isDebugEnabled, redactForLog } from '@/utils/debug';
import { applySpoofHeaders } from '@/utils/spoofer';
import { resolveAnthropicBody, isSkillResolverReady } from '../SkillResolver';
import { handleModels, handleMessages, handleMessagesBatches } from './handlers';
import {
    isAutoModel, configHasModel, isEmbeddingsEnabled, isSttOrTtsOnlyConfig,
    isImageOnlyConfig, providerSupportsModalities, stripReasoningFields, hasExplicitReasoningRequest,
    buildRouteCacheKey, isReasoningConfiguredForModel,
    resolveReasoningEffort, countTokensFromContent,
    buildWebSearchEncryptedContent, buildCodeInterpreterSessionId,
    ensureToolCallThoughtSignatures, buildAnthropicWebSearchBlocks,
    getRequiredModalities,
} from './helpers';
import {
    getCandidateModelsForProvider, getOptimizedBackends as getOptimizedBackendsFn, isGeminiProvider as isGeminiProviderFn,
} from './routing';

type OpenAIModelConfig = NonNullable<Config['models']['openai']>[number];
type Modality = OpenAIModelConfig['modalities']['input'][number];

export class AnthropicProxy {
  readonly app: Hono;
  readonly webSearchHandler = webSearchHandler;
  readonly codeInterpreterHandler = codeInterpreterHandler;
  readonly providerStats = new ProviderStatsTracker();
  readonly CONFIG = CONFIG;
  readonly rateLimitManager = rateLimitManager;
  readonly backendCooldownManager = backendCooldownManager;
  private readonly backendRouteCache = new Map<string, OpenAIModelConfig[]>();
  private readonly rrIndexByKey = new Map<string, number>();

  constructor() {
    this.app = new Hono();
    this.setupRoutes();
  }

  getApp(): Hono {
    return this.app;
  }

  private setupRoutes(): void {
    this.app.get( '/v1/models', ( c: Context ) => handleModels( this, c ) );
    this.app.post( '/v1/messages', ( c: Context ) => handleMessages( this, c ) );
    this.app.post( '/v1/messages/batches', ( c: Context ) => handleMessagesBatches( this, c ) );
    this.app.post( '/messages', ( c: Context ) => handleMessages( this, c ) );
  }

  getUnifiedModelCatalog() { return getUnifiedModelCatalog( CONFIG.proxy ); }
  convertAnthropicRequestToOpenAI( body: any, model: string, format: 'native' | 'xml' ) { return convertAnthropicRequestToOpenAI( body, model, format ); }
  convertOpenAIResponseToAnthropic( response: any, model: string ) { return convertOpenAIResponseToAnthropic( response, model ); }
  relayUpstreamToStreamWriter( c: Context, response: Response, model: string, writer: any, blocks?: any[], startedAt?: number ) { return relayUpstreamToStreamWriter( c, response, model, writer, blocks, startedAt ); }
  fetchWithProxy( url: string, init: any, proxyCfg: any, opts?: any ) { return fetchWithProxy( url, init, proxyCfg, opts ); }
  formatTimingEntries( entries: Record<string, number> ) { return formatTimingEntries( entries ); }
  isDebugEnabled() { return isDebugEnabled(); }
  redactForLog( payload: any ) { return redactForLog( payload ); }
  isSkillResolverReady() { return isSkillResolverReady(); }
  resolveAnthropicBody( body: any ) { return resolveAnthropicBody( body ); }
  countTokensFromContent( content: any ) { return countTokensFromContent( content ); }
  buildCodeInterpreterSessionId() { return buildCodeInterpreterSessionId(); }
  buildWebSearchEncryptedContent( t: string, u: string, s: string ) { return buildWebSearchEncryptedContent( t, u, s ); }

  hasAnthropicToolSearchRequest( body: any ): boolean {
    const tools = Array.isArray( body?.tools ) ? body.tools : [];
    return tools.some( ( tool: any ) =>
      ( typeof tool?.type === 'string' && /^tool_search_tool_(regex|bm25)_\d+$/.test( tool.type ) )
      || ( typeof tool?.name === 'string' && /^(tool_search_tool_regex|tool_search_tool_bm25)$/.test( tool.name ) )
    );
  }

  attachAnthropicToolSearchUsage( payload: any, enabled: boolean ): any {
    if ( !enabled || !payload || typeof payload !== 'object' || Array.isArray( payload ) ) return payload;
    const usage = payload.usage && typeof payload.usage === 'object' ? payload.usage : {};
    const serverToolUse = usage.server_tool_use && typeof usage.server_tool_use === 'object' ? usage.server_tool_use : {};
    return { ...payload, usage: { ...usage, server_tool_use: { ...serverToolUse, tool_search_requests: ( serverToolUse.tool_search_requests ?? 0 ) + 1 } } };
  }

  getBackendsForModel( modelName: string, requiredModalities: readonly Modality[] = ['text'], targetGroup?: string ): OpenAIModelConfig[] {
    const effectiveGroup = targetGroup || 'default';
    const cacheKey = buildRouteCacheKey( modelName, requiredModalities ) + `|${effectiveGroup}`;
    const cached = this.backendRouteCache.get( cacheKey );
    if ( cached ) return cached;

    const configs = CONFIG.models.openai || [];
    const modelIsListed = configs.some( config => configHasModel( config, modelName ) );
    const isAuto = isAutoModel( modelName ) || !modelIsListed;
    const exact: OpenAIModelConfig[] = [];
    const fallback: OpenAIModelConfig[] = [];

    for ( const config of configs ) {
      // Never route Anthropic text/messages through image/STT/TTS/embeddings providers
      if ( isSttOrTtsOnlyConfig( config ) || isEmbeddingsEnabled( config ) || isImageOnlyConfig( config ) || !providerSupportsModalities( config, requiredModalities ) ) continue;
      // Group isolation: only applies to auto-edge (fallback) routing.
      // Explicit model requests always gather all providers regardless of group.
      if ( isAuto && ( config as any ).groupSpace !== effectiveGroup ) continue;
      if ( configHasModel( config, modelName ) ) exact.push( config );
      else if ( isAuto || config.randomRouting !== false ) fallback.push( config );
    }

    const result = isAuto ? fallback : modelIsListed ? [...exact, ...fallback] : fallback;
    this.backendRouteCache.set( cacheKey, result );
    return result;
  }

  getBackendConfigForModel( modelName: string ): OpenAIModelConfig {
    const configs = CONFIG.models.openai;
    if ( !configs || !configs.length ) throw new Error( 'No OpenAI backend configured' );
    const matching = this.getBackendsForModel( modelName );
    if ( !matching.length ) throw new Error( `Model not found: ${modelName}` );
    return this.getRoundRobinBackends( modelName, matching )[0]!;
  }

  getOpenAIEndpointForAnthropicEndpoint( endpoint: string ): string {
    if ( endpoint === 'messages' ) return 'chat/completions';
    throw new Error( `Unsupported Anthropic endpoint mapping: ${endpoint}` );
  }

  getRoundRobinBackends( modelName: string, backends: OpenAIModelConfig[] ): OpenAIModelConfig[] {
    if ( backends.length <= 1 ) return backends;
    const key = `anthropic:model:${modelName}`;
    const startIndex = this.getAndIncrementRoundRobinIndex( key, backends.length );
    return [...backends.slice( startIndex ), ...backends.slice( 0, startIndex )];
  }

  private getAndIncrementRoundRobinIndex( key: string, total: number ): number {
    if ( total <= 0 ) return 0;
    const current = this.rrIndexByKey.get( key ) ?? 0;
    const index = current % total;
    this.rrIndexByKey.set( key, ( index + 1 ) % total );
    return index;
  }

  buildHeaders( config: OpenAIModelConfig, stream = false ): Record<string, string> {
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
    return CONFIG.spoofer === true ? applySpoofHeaders( headers ) : headers;
  }

  getOptimizedBackends( modelName: string, backends: OpenAIModelConfig[], requiredModalities: readonly Modality[] ): OpenAIModelConfig[] {
    return getOptimizedBackendsFn( modelName, backends, requiredModalities, buildRouteCacheKey, this.getRoundRobinBackends.bind( this ), this.providerStats );
  }

  getCandidateModelsForProvider( config: OpenAIModelConfig, requestedModel: string, requiredModalities: readonly Modality[] = ['text'] ): string[] {
    return getCandidateModelsForProvider( config, requestedModel, requiredModalities );
  }

  getRequiredModalities( body: any ): Modality[] {
    return getRequiredModalities( body ) as Modality[];
  }

  isGeminiProvider( config: OpenAIModelConfig ): boolean {
    return isGeminiProviderFn( config );
  }

  withReasoningEffort( openAIRequest: any, sourceBody: any, config: OpenAIModelConfig, selectedModel: string ): any {
    if ( !isReasoningConfiguredForModel( config, selectedModel ) ) return stripReasoningFields( openAIRequest );
    if ( openAIRequest?.stream === true && !hasExplicitReasoningRequest( sourceBody ) ) return openAIRequest;
    const effort = resolveReasoningEffort( sourceBody, config, selectedModel );
    if ( !effort || effort === 'none' ) return openAIRequest;
    return { ...openAIRequest, reasoning_effort: effort };
  }

  getEffectiveRateLimit( config: OpenAIModelConfig ): Config['rateLimit'] | undefined {
    return config.individualLimit && config.rateLimit ? config.rateLimit : CONFIG.rateLimit;
  }

  parseResponsePayload( response: Response ): Promise<any> {
    const contentType = response.headers.get( 'content-type' ) ?? '';
    if ( contentType.includes( 'application/json' ) ) {
      return response.json().catch( () => ({ error: { message: 'Upstream returned invalid JSON', type: 'upstream_error' } }) );
    }
    return response.text().catch( () => '' ).then( text => !text
      ? { error: { message: response.statusText || 'Upstream request failed', type: 'upstream_error' } }
      : text );
  }

  normalizeBaseUrl( baseUrl: string ): string { return baseUrl.replace( /\/+$/, '' ); }

  calculateTokenCount( body: any ): number {
    if ( !body ) return 0;
    let totalTokens = 0;
    if ( body.messages && Array.isArray( body.messages ) ) {
      for ( const msg of body.messages ) {
        totalTokens += countTokensFromContent( msg.content );
        if ( msg.tool_calls ) for ( const tool of msg.tool_calls ) totalTokens += Math.max( 1, Math.ceil( JSON.stringify( tool.function.arguments ).length / 4 ) );
      }
    }
    if ( body.system ) totalTokens += countTokensFromContent( body.system );
    if ( totalTokens === 0 ) totalTokens = 100;
    return totalTokens;
  }

  attachUsageIfMissing( endpoint: string, requestBody: any, responseData: any ): any {
    if ( !responseData || typeof responseData !== 'object' || Array.isArray( responseData ) ) return responseData;
    if ( responseData.usage ) return responseData;
    return { ...responseData, usage: { input_tokens: this.calculateTokenCount( requestBody ), output_tokens: countTokensFromContent( responseData.content || responseData.output || '' ) } };
  }

  ensureToolCallThoughtSignatures( body: any ): any {
    return ensureToolCallThoughtSignatures( body );
  }

  buildAnthropicWebSearchBlocks( searchResponse: any ): any[] {
    return buildAnthropicWebSearchBlocks( searchResponse, this.buildWebSearchEncryptedContent.bind( this ) );
  }
}

export const anthropicProxy = new AnthropicProxy();
