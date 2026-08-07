import { Hono } from 'hono';
import type { Context } from 'hono';
import { stream } from 'hono/streaming';
import { rateLimitManager } from './RateLimitManager';
import { CONFIG } from '@/utils/schema.lookup';
import { fetchWithProxy } from '@/utils/proxyFetch';
import type { Config } from '@/schema';
import { webSearchManager, type WebSearchResponse } from './WebSearchManager';
import { codeInterpreterManager } from './CodeInterpreterManager';
import { stripFreeModifier } from '@/utils/modelIds';
import { getUnifiedModelCatalog } from '@/utils/modelCatalog';
import { formatTimingEntries } from '@/utils/timing';
import {
    buildCodeInterpreterToolDefinition,
    normalizeToolChoice,
    runCodeInterpreterToolLoop,
    stripCodeInterpreterTools,
    type CodeInterpreterToolRun,
    isCodeInterpreterTool,
} from './codeInterpreterFlow';
import { backendCooldownManager } from './BackendCooldownManager';
import { ProviderStatsTracker } from './ProviderStatsTracker';
import { isDebugEnabled, redactForLog } from '@/utils/debug';
import { applySpoofHeaders } from '@/utils/spoofer';
import { startStreamHeartbeat } from '@/utils/streamHeartbeat';
import { resolveOpenAIBody, isSkillResolverReady } from './SkillResolver';
import { isStringContentOnlyProvider, normalizeMessagesContentToString, getRequiredInputModalities, providerSupportsInputModalities, modelSupportsInputModalities, modelEntrySupportsInputModalities } from './routing/shared';
import type { InputModality } from './routing/shared';
import {
    convertResponsesRequestToChat,
    convertChatResponseToResponses,
    createResponsesStreamState,
    processChatStreamChunkForResponses,
    emitResponsesCompleted,
    emitResponsesDoneSentinel,
    type FileSearchCallItem,
} from './ResponsesConversion';
import { fileSearchManager, type FileSearchResponse } from './FileSearchManager';

type OpenAIModelConfig = NonNullable<Config['models']['openai']>[number];
type ReasoningEffort = NonNullable<OpenAIModelConfig['default_reasoning']>;
const AUTO_MODEL_ID = 'auto';
const FAST_MODEL_HINTS = ['flash-lite', 'lite', 'mini', 'small', 'fast'];

export class OpenAIProxy {
    private app: Hono;
    private readonly rrIndexByKey = new Map<string, number>();
    private readonly providerStats = new ProviderStatsTracker();
    private readonly backendRouteCache = new Map<string, OpenAIModelConfig[]>();
    private readonly optimizedBackendCache = new Map<string, { backends: OpenAIModelConfig[]; expiresAt: number }>();
    private static readonly MAX_CACHE_SIZE = 1000;
    private static readonly BACKEND_CACHE_TTL_MS = 30_000;
    private static readonly MAX_FALLBACK_BACKENDS = 6;  // Cap backends per request to prevent routing loops
    private static readonly MAX_SIBLING_MODELS_PER_PROVIDER = 4;  // Cap sibling-model substitution per provider in the last-resort pass

    constructor() {
        this.app = new Hono();
        this.setupRoutes();
    }

    getApp(): Hono {
        return this.app;
    }

    private setupRoutes(): void {
        this.app.get( '/v1/models', ( c: Context ) => this.handleModels( c ) );
        this.app.post( '/v1/responses', ( c: Context ) => this.handleResponses( c ) );
        this.app.post( '/v1/responses/compact', ( c: Context ) => this.handleResponsesCompact( c ) );
        this.app.post( '/v1/chat/completions', ( c: Context ) => this.handleChatCompletions( c ) );
        this.app.post( '/v1/embeddings', ( c: Context ) => this.handleEmbeddings( c ) );
        this.app.post( '/v1/completions', ( c: Context ) => this.handleCompletions( c ) );
        this.app.post( '/v1/images/generations', ( c: Context ) => this.handleImageGenerations( c ) );
        this.app.post( '/v1/images/edits', ( c: Context ) => this.handleImageEdits( c ) );
        this.app.post( '/v1/audio/transcriptions', ( c: Context ) => this.handleAudioTranscriptions( c ) );
        this.app.post( '/v1/audio/translations', ( c: Context ) => this.handleAudioTranslations( c ) );
        this.app.post( '/v1/audio/speech', ( c: Context ) => this.handleAudioSpeech( c ) );
    }

    private async handleModels( c: Context ) {
        try {
            const configs = CONFIG.models.openai ?? [];
            if ( !configs.length ) {
                console.error( '[/v1/models] No backend configured' );
                return c.json( { error: 'No backend configured' }, 503 );
            }

            const catalog = await getUnifiedModelCatalog( CONFIG.proxy );
            return c.json( {
                object: 'list',
                data: catalog.data,
            } );
        } catch ( error: any ) {
            console.error( '[/v1/models] Exception:', error?.message || String( error ) );
            return c.json( { error: 'Failed to fetch models' }, 500 );
        }
    }

    private async handleResponses( c: Context ) {
        return this.handleOpenAIRequest( c, 'responses' );
    }

    private async handleResponsesCompact( c: Context ) {
        const rawBody = await c.req.json().catch( () => ( {} ) );
        const input = rawBody.input as any[] | undefined;
        const model = rawBody.model as string | undefined;

        if ( !model ) {
            return c.json( {
                error: { message: 'model is required', type: 'invalid_request_error' },
            }, 400 );
        }

        if ( !Array.isArray( input ) || input.length === 0 ) {
            return c.json( {
                error: { message: 'input must be a non-empty array', type: 'invalid_request_error' },
            }, 400 );
        }

        // Separate system/developer messages from conversation messages
        const systemItems: any[] = [];
        const conversationItems: any[] = [];

        for ( const item of input ) {
            const role = item?.role as string | undefined;
            if ( role === 'system' || role === 'developer' ) {
                systemItems.push( item );
            } else {
                conversationItems.push( item );
            }
        }

        // Keep the last N conversation items to stay within a reasonable token window
        const maxConversationItems = 40;
        const keptConversation = conversationItems.length > maxConversationItems
            ? conversationItems.slice( conversationItems.length - maxConversationItems )
            : conversationItems;

        // Summarize dropped items into a summary message if any were dropped
        const droppedCount = conversationItems.length - keptConversation.length;
        const output: any[] = [...systemItems];

        if ( droppedCount > 0 ) {
            output.push( {
                type: 'message',
                role: 'user',
                content: [
                    {
                        type: 'input_text',
                        text: `[Context compacted: ${droppedCount} earlier messages were summarized to fit within context limits.]`,
                    },
                ],
            } );
        }

        output.push( ...keptConversation );

        return c.json( {
            id: `compact_${Date.now().toString( 36 )}`,
            object: 'response.compact',
            model,
            output,
            usage: {
                input_tokens: Math.ceil( JSON.stringify( output ).length / 4 ),
                input_tokens_details: { cached_tokens: 0 },
                output_tokens: 0,
                output_tokens_details: { reasoning_tokens: 0 },
                total_tokens: Math.ceil( JSON.stringify( output ).length / 4 ),
            },
        } );
    }

    private async handleChatCompletions( c: Context ) {
        return this.handleOpenAIRequest( c, 'chat/completions' );
    }

    private async handleEmbeddings( c: Context ) {
        return this.proxyRequest( c, 'embeddings' );
    }

    private async handleCompletions( c: Context ) {
        return this.proxyRequest( c, 'completions' );
    }

    private async handleImageGenerations( c: Context ) {
        return this.proxyRequest( c, 'images/generations' );
    }

    private async handleImageEdits( c: Context ) {
        return this.proxyRequest( c, 'images/edits' );
    }

    // ── Speech-to-Text (STT) handlers ──

    private isSttEnabled( config: OpenAIModelConfig ): boolean {
        return config.stt === true;
    }

    private isTtsEnabled( config: OpenAIModelConfig ): boolean {
        return config.tts === true;
    }

    private isSttOrImageOnlyConfig( config: OpenAIModelConfig ): boolean {
        return this.isSttEnabled( config ) || this.isTtsEnabled( config ) || this.isImageOnlyConfig( config );
    }

    private async handleAudioTranscriptions( c: Context ) {
        return this.handleAudioRequest( c, 'audio/transcriptions' );
    }

    private async handleAudioTranslations( c: Context ) {
        return this.handleAudioRequest( c, 'audio/translations' );
    }

    /**
     * Handle multipart/form-data audio requests (transcriptions + translations).
     * These differ from JSON-based endpoints because:
     *  1. The request body is multipart/form-data, not JSON
     *  2. Rate limiting is based on audio duration (seconds), not tokens
     *  3. Only STT-flagged providers should receive these requests
     */
    private async handleAudioRequest( c: Context, endpoint: string ): Promise<any> {
        const requestStartedAt = Date.now();
        let lastFailure: { status: number; payload: any } | null = null;

        try {
            // Parse the multipart form data
            const formData = await c.req.formData();
            const model = formData.get( 'model' ) as string | null;
            const file = formData.get( 'file' ) as File | null;

            if ( !model ) {
                return c.json( { error: { message: 'model is required', type: 'invalid_request_error' } }, 400 );
            }
            if ( !file ) {
                return c.json( { error: { message: 'file is required', type: 'invalid_request_error' } }, 400 );
            }

            // Estimate audio duration from the file size and format
            // For WAV/PCM: duration ≈ fileSize / (sampleRate * channels * bytesPerSample)
            // For compressed formats (mp3, m4a, etc.): use a rough heuristic
            const audioSeconds = this.estimateAudioDuration( file );

            // Find STT-capable backends for this model
            const matchingBackends = this.getBackendsForModel( model, endpoint );
            if ( !matchingBackends.length ) {
                console.error( `[${endpoint}] No STT backends found for model: ${model}` );
                return c.json( {
                    error: {
                        message: `Model not found: ${model}`,
                        type: 'invalid_request_error'
                    }
                }, 400 );
            }

            const backends = this.getOptimizedBackends( model, endpoint, matchingBackends );
            console.error( `[${endpoint}] Attempting backends for model ${model}: ${backends.map( b => b.id ).join( ', ' )}` );

            for ( const config of backends ) {
                const candidateModels = this.getCandidateModelsForProvider( config, model );

                for ( const selectedModel of candidateModels ) {
                    // Check cooldown
                    const cooldownRemainingMs = backendCooldownManager.getRemainingMs( config.id, selectedModel );
                    if ( cooldownRemainingMs > 0 ) {
                        console.warn( `[${endpoint}] cooldown_active provider=${config.id} model=${selectedModel} remainingMs=${cooldownRemainingMs}` );
                        continue;
                    }

                    // Check STT-specific rate limits (audio seconds per hour/day)
                    const sttRateLimit = this.getEffectiveSTTRateLimit( config, selectedModel );
                    const audioRateCheck = await rateLimitManager.checkAndConsumeAudioSeconds(
                        config.id,
                        audioSeconds,
                        sttRateLimit,
                        selectedModel
                    );
                    if ( !audioRateCheck.allowed ) {
                        console.error( `[${endpoint}] STT rate limit exceeded for ${config.id}: ${audioRateCheck.reason}` );
                        continue;
                    }

                    try {
                        const url = this.buildApiUrl( config, endpoint );

                        // OpenAI v2025+ streaming STT fields
                        const streamField = formData.get( 'stream' );
                        const wantsStream = streamField === 'true' || streamField === '1';

                        // Collect all fields to forward into a raw multipart body.
                        // Hono-parsed File objects don't serialize correctly through undici FormData,
                        // so we build multipart/form-data manually as a Buffer.
                        const boundary = `----AIEDGE${Math.random().toString( 36 ).slice( 2 )}`;
                        const parts: ( string | Buffer )[] = [];

                        function appendText( name: string, value: string ) {
                            parts.push(
                                `--${boundary}\r\n`,
                                `Content-Disposition: form-data; name="${name}"\r\n\r\n`,
                                `${value}\r\n`,
                            );
                        }

                        appendText( 'model', selectedModel );

                        // File part
                        const fileBuffer = Buffer.from( await file.arrayBuffer() );
                        const fileName = file.name || 'audio.wav';
                        const fileType = file.type || 'audio/wav';
                        parts.push(
                            `--${boundary}\r\n`,
                            `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`,
                            `Content-Type: ${fileType}\r\n\r\n`,
                            fileBuffer,
                            `\r\n`,
                        );

                        // Forward all optional fields
                        const textFields = ['language', 'prompt', 'response_format', 'temperature'] as const;
                        for ( const field of textFields ) {
                            const val = formData.get( field );
                            if ( val ) appendText( field, val as string );
                        }

                        const timestampGranularities = formData.getAll( 'timestamp_granularities[]' );
                        for ( const tg of timestampGranularities ) {
                            appendText( 'timestamp_granularities[]', tg as string );
                        }

                        if ( wantsStream ) {
                            appendText( 'stream', 'true' );
                        }

                        const includeFields = formData.getAll( 'include[]' );
                        for ( const inc of includeFields ) {
                            appendText( 'include[]', inc as string );
                        }

                        const chunkingStrategy = formData.get( 'chunking_strategy' );
                        if ( chunkingStrategy ) {
                            appendText( 'chunking_strategy', chunkingStrategy as string );
                        }

                        const knownSpeakerNames = formData.getAll( 'known_speaker_names[]' );
                        for ( const name of knownSpeakerNames ) {
                            appendText( 'known_speaker_names[]', name as string );
                        }
                        const knownSpeakerReferences = formData.getAll( 'known_speaker_references[]' );
                        for ( const ref of knownSpeakerReferences ) {
                            appendText( 'known_speaker_references[]', ref as string );
                        }

                        parts.push( `--${boundary}--\r\n` );
                        const upstreamBody = Buffer.concat( parts.map( p => typeof p === 'string' ? Buffer.from( p ) : p ) );

                        console.info( `[${endpoint}] upstream_request provider=${config.id} model=${selectedModel} audioSeconds=${audioSeconds} stream=${wantsStream}` );

                        const upstreamResponse = await fetchWithProxy( url, {
                            method: 'POST',
                            headers: {
                                'Authorization': `Bearer ${config.apiKey}`,
                                'Content-Type': `multipart/form-data; boundary=${boundary}`,
                                'User-Agent': 'ai-edge/1.0',
                            },
                            body: upstreamBody,
                        }, CONFIG.proxy, { skipTimeout: wantsStream } );

                        backendCooldownManager.markFromStatus( config.id, selectedModel, upstreamResponse.status );

                        if ( upstreamResponse.status === 429 ) {
                            this.providerStats.recordFailure( config.id, selectedModel, Date.now() - requestStartedAt );
                            console.warn( `[${endpoint}] 429 from ${config.id}, trying next backend` );
                            break;
                        }

                        if ( !upstreamResponse.ok ) {
                            lastFailure = {
                                status: upstreamResponse.status,
                                payload: await this.parseResponsePayload( upstreamResponse ),
                            };
                            this.providerStats.recordFailure( config.id, selectedModel, Date.now() - requestStartedAt );
                            console.error( `[${endpoint}] ${upstreamResponse.status} from ${config?.id ?? config?.name}` );
                            break;
                        }

                        // Handle streaming SSE response (transcript.text.delta / transcript.text.done)
                        const upstreamContentType = upstreamResponse.headers.get( 'content-type' ) || 'application/json';
                        if ( wantsStream && upstreamContentType.includes( 'text/event-stream' ) ) {
                            console.info( `[${endpoint}] stream_start provider=${config.id} model=${selectedModel} audioSeconds=${audioSeconds}` );
                            this.providerStats.recordSuccess( config.id, selectedModel, Date.now() - requestStartedAt );
                            return this.proxyAudioStream( c, upstreamResponse, endpoint, config.id, selectedModel );
                        }

                        // Non-streaming: read full response and forward
                        const responseText = await upstreamResponse.text();

                        console.info( `[${endpoint}] success provider=${config.id} model=${selectedModel} audioSeconds=${audioSeconds} totalMs=${Date.now() - requestStartedAt}` );
                        this.providerStats.recordSuccess( config.id, selectedModel, Date.now() - requestStartedAt );

                        // Return the response in the same format as upstream
                        if ( upstreamContentType.includes( 'text/plain' ) || upstreamContentType.includes( 'text/vtt' ) || upstreamContentType.includes( 'application/x-subrip' ) ) {
                            c.header( 'Content-Type', upstreamContentType );
                            return c.text( responseText );
                        }

                        // Default: return JSON
                        try {
                            return c.json( JSON.parse( responseText ) );
                        } catch {
                            c.header( 'Content-Type', upstreamContentType );
                            return c.body( responseText );
                        }
                    } catch ( error: any ) {
                        this.providerStats.recordFailure( config.id, selectedModel );
                        lastFailure = {
                            status: 502,
                            payload: {
                                error: {
                                    message: error?.message || 'Upstream request failed',
                                    type: 'upstream_error'
                                }
                            }
                        };
                        console.error( `[${endpoint}] Exception from ${config?.id ?? config?.name}: ${error?.message || String( error )}` );
                        break;
                    }
                }
            }

            if ( lastFailure ) {
                const errorPayload = typeof lastFailure.payload === 'object' ? JSON.stringify( lastFailure.payload ) : String( lastFailure.payload );
                console.error( `\n❌ [${endpoint}] FINAL FAILURE (${lastFailure.status})\nAttempted backends: ${backends.map( b => b.id ).join( ', ' )}\nError: ${errorPayload}\n` );
                return this.sendFailurePayload( c, lastFailure.status, lastFailure.payload );
            }

            console.error( `\n❌ [${endpoint}] ALL PROVIDERS FAILED\nModel: ${model}\nAttempted: ${backends.map( b => b.id ).join( ', ' )}\n` );
            return c.json( { error: { message: 'All providers failed', type: 'internal_error' } }, 502 );

        } catch ( error: any ) {
            console.error( `[${endpoint}] Exception:`, error?.message || String( error ) );
            return c.json( { error: { message: error?.message || 'Internal error', type: 'internal_error' } }, 500 );
        }
    }

    /**
     * Estimate audio duration in seconds from a File object.
     * Uses file extension heuristics when precise duration calculation isn't possible.
     */
    private estimateAudioDuration( file: File ): number {
        const name = file.name.toLowerCase();
        const sizeBytes = file.size;

        // For WAV files, try to parse the header for exact duration
        // WAV header: bytes 28-31 = byteRate (sampleRate * channels * bitsPerSample/8)
        // duration = fileSize / byteRate (approx, header is 44 bytes)
        if ( name.endsWith( '.wav' ) || name.endsWith( '.wave' ) ) {
            // We'll use a rough heuristic based on typical 16kHz mono 16-bit audio
            // 16000 * 1 * 2 = 32000 bytes/second
            const defaultByteRate = 32000; // 16kHz, mono, 16-bit
            return Math.max( 1, Math.ceil( sizeBytes / defaultByteRate ) );
        }

        // For MP3 files: ~128kbps = 16000 bytes/second, ~64kbps = 8000 bytes/second
        if ( name.endsWith( '.mp3' ) ) {
            const bytesPerSecond = 16000; // assume ~128kbps
            return Math.max( 1, Math.ceil( sizeBytes / bytesPerSecond ) );
        }

        // For M4A/AAC files: ~128kbps
        if ( name.endsWith( '.m4a' ) || name.endsWith( '.aac' ) || name.endsWith( '.mp4' ) ) {
            const bytesPerSecond = 16000;
            return Math.max( 1, Math.ceil( sizeBytes / bytesPerSecond ) );
        }

        // For OGG/Opus: ~32kbps typical for voice
        if ( name.endsWith( '.ogg' ) || name.endsWith( '.opus' ) || name.endsWith( '.oga' ) ) {
            const bytesPerSecond = 4000;
            return Math.max( 1, Math.ceil( sizeBytes / bytesPerSecond ) );
        }

        // For FLAC: ~500KB/min ≈ 8333 bytes/second
        if ( name.endsWith( '.flac' ) ) {
            const bytesPerSecond = 8333;
            return Math.max( 1, Math.ceil( sizeBytes / bytesPerSecond ) );
        }

        // Default fallback: assume 64kbps
        return Math.max( 1, Math.ceil( sizeBytes / 8000 ) );
    }

    private getEffectiveSTTRateLimit( config: OpenAIModelConfig, modelName?: string ): Config['rateLimit'] {
        // Check per-model rate limit first
        if ( modelName && config.individualLimit ) {
            const modelEntry = config.models.find( m => {
                const candidate = typeof m === 'string' ? m : ( m as any ).model;
                return stripFreeModifier( candidate ).normalizedId === stripFreeModifier( modelName ).normalizedId;
            } );
            if ( modelEntry && typeof modelEntry === 'object' && ( modelEntry as any ).rateLimit ) {
                return ( modelEntry as any ).rateLimit;
            }
        }
        // Fall back to provider-level rate limit
        return config.rateLimit;
    }

    private getEffectiveTTSRateLimit( config: OpenAIModelConfig, modelName?: string ): Config['rateLimit'] {
        // Check per-model rate limit first
        if ( modelName && config.individualLimit ) {
            const modelEntry = config.models.find( m => {
                const candidate = typeof m === 'string' ? m : ( m as any ).model;
                return stripFreeModifier( candidate ).normalizedId === stripFreeModifier( modelName ).normalizedId;
            } );
            if ( modelEntry && typeof modelEntry === 'object' && ( modelEntry as any ).rateLimit ) {
                return ( modelEntry as any ).rateLimit;
            }
        }
        // Fall back to provider-level rate limit
        return config.rateLimit;
    }

    /**
     * Map OpenAI-style TTS voice names to provider-native voice names.
     * If the voice is already recognized by the provider, it is returned as-is.
     */
    private mapTTSVoice( voice: string, model: string ): string {
        // Voices that Orpheus already accepts natively
        const orpheusVoices = new Set( [
            'autumn', 'diana', 'hannah', 'austin', 'daniel', 'troy',
        ] );
        const arabicVoices = new Set( [
            'abdullah', 'fahad', 'sultan', 'lulwa', 'noura', 'aisha',
        ] );

        const lower = voice.toLowerCase();

        if ( model.includes( 'arabic' ) ) {
            if ( arabicVoices.has( lower ) ) return lower;
            // Fallback for Arabic model
            return 'abdullah';
        }

        // English model
        if ( orpheusVoices.has( lower ) ) return lower;

        // OpenAI voice → Orpheus voice mapping
        const openaiToOrpheus: Record<string, string> = {
            alloy: 'troy',
            echo: 'daniel',
            fable: 'hannah',
            onyx: 'austin',
            nova: 'diana',
            shimmer: 'autumn',
        };

        return openaiToOrpheus[lower] ?? 'troy';
    }

    /**
     * Force or adapt the response format for a given provider.
     * Groq Orpheus only supports "wav", so we override non-wav requests.
     */
    private getUpstreamResponseFormat( config: OpenAIModelConfig, requestedFormat?: string ): string | undefined {
        if ( !requestedFormat ) return undefined;

        const fmt = requestedFormat.toLowerCase();

        // Groq Orpheus only supports wav
        if ( config.baseUrl.includes( 'groq.com' ) && fmt !== 'wav' ) {
            return 'wav';
        }

        return requestedFormat;
    }

    /**
     * Proxy a streaming SSE response from an upstream STT provider.
     * Forwards events like transcript.text.delta, transcript.text.done, etc.
     * directly to the client without transformation, since STT SSE format
     * is provider-specific.
     */
    private async proxyAudioStream(
        c: Context,
        upstreamResponse: Response,
        endpoint: string,
        providerId: string,
        selectedModel: string,
    ): Promise<Response> {
        const encoder = new TextEncoder();
        const upstreamReader = upstreamResponse.body!.getReader();
        const decoder = new TextDecoder();
        let clientDisconnected = false;

        c.header( 'Content-Type', 'text/event-stream; charset=utf-8' );
        c.header( 'Cache-Control', 'no-cache, no-transform' );
        c.header( 'Connection', 'keep-alive' );
        c.header( 'X-Accel-Buffering', 'no' );

        const clientSignal = c.req.raw.signal;
        const onClientAbort = () => {
            clientDisconnected = true;
            upstreamReader.cancel( 'client disconnected' ).catch( () => { } );
        };
        clientSignal.addEventListener( 'abort', onClientAbort, { once: true } );

        const stream = new ReadableStream( {
            start( controller ) {
                ( async () => {
                    try {
                        while ( !clientDisconnected ) {
                            const { done, value } = await upstreamReader.read();
                            if ( done ) break;
                            if ( value ) {
                                // Forward raw SSE chunks from upstream directly to client
                                controller.enqueue( value );
                            }
                        }

                        console.info( `[${endpoint}] stream_complete provider=${providerId} model=${selectedModel}` );
                    } catch ( err: any ) {
                        console.error( `[${endpoint}] stream_error provider=${providerId} model=${selectedModel}: ${err?.message || String( err )}` );
                        // Try to emit an error event so the client knows
                        try {
                            const errorEvent = `event: error\ndata: ${JSON.stringify( {
                                type: 'error',
                                error: { type: 'upstream_error', message: err?.message || 'Stream error' },
                            } )}\n\n`;
                            controller.enqueue( encoder.encode( errorEvent ) );
                        } catch { /* stream may already be closed */ }
                    }
                } )().finally( () => {
                    clientSignal.removeEventListener( 'abort', onClientAbort );
                    try { upstreamReader.releaseLock(); } catch { /* ignore */ }
                    try { controller.close(); } catch { /* stream may already be closed */ }
                } );
            },
        } );

        return new Response( stream, {
            status: 200,
            headers: {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
            },
        } );
    }

    /**
     * Handle POST /v1/audio/speech — Text-to-Speech (TTS).
     * The OpenAI TTS API accepts a JSON body (not multipart) with:
     *   model, input (text), voice, instructions, response_format, speed, stream_format
     * and returns raw audio bytes (or SSE stream).
     */
    private async handleAudioSpeech( c: Context ) {
        const endpoint = 'audio/speech';
        const requestStartedAt = Date.now();
        let lastFailure: { status: number; payload: any } | null = null;

        try {
            const body = await c.req.json().catch( () => ( {} ) );
            const model = body?.model as string | undefined;
            const input = body?.input as string | undefined;
            const voice = body?.voice as string | undefined;

            if ( !model ) {
                return c.json( { error: { message: 'model is required', type: 'invalid_request_error' } }, 400 );
            }
            if ( !input || typeof input !== 'string' ) {
                return c.json( { error: { message: 'input is required', type: 'invalid_request_error' } }, 400 );
            }
            if ( !voice ) {
                return c.json( { error: { message: 'voice is required', type: 'invalid_request_error' } }, 400 );
            }

            const characters = input.length;
            const wantsStream = body?.stream === true || body?.stream_format != null;

            // Find TTS-capable backends
            const matchingBackends = this.getBackendsForModel( model, endpoint );
            if ( !matchingBackends.length ) {
                console.error( `[${endpoint}] No TTS backends found for model: ${model}` );
                return c.json( {
                    error: {
                        message: `Model not found: ${model}`,
                        type: 'invalid_request_error'
                    }
                }, 400 );
            }

            const backends = this.getOptimizedBackends( model, endpoint, matchingBackends );
            console.error( `[${endpoint}] Attempting backends for model ${model}: ${backends.map( b => b.id ).join( ', ' )}` );

            for ( const config of backends ) {
                const candidateModels = this.getCandidateModelsForProvider( config, model );

                for ( const selectedModel of candidateModels ) {
                    // Check cooldown
                    const cooldownRemainingMs = backendCooldownManager.getRemainingMs( config.id, selectedModel );
                    if ( cooldownRemainingMs > 0 ) {
                        console.warn( `[${endpoint}] cooldown_active provider=${config.id} model=${selectedModel} remainingMs=${cooldownRemainingMs}` );
                        continue;
                    }

                    // Check TTS-specific rate limits (characters per hour/day)
                    const ttsRateLimit = this.getEffectiveTTSRateLimit( config, selectedModel );
                    const charRateCheck = await rateLimitManager.checkAndConsumeTTSCharacters(
                        config.id,
                        characters,
                        ttsRateLimit,
                        selectedModel
                    );
                    if ( !charRateCheck.allowed ) {
                        console.error( `[${endpoint}] TTS rate limit exceeded for ${config.id}: ${charRateCheck.reason}` );
                        continue;
                    }

                    try {
                        const url = this.buildApiUrl( config, endpoint );

                        // Map OpenAI-style voices to provider-native voices
                        const mappedVoice = this.mapTTSVoice( voice, selectedModel );

                        // Build upstream JSON body
                        const upstreamBody: Record<string, any> = {
                            model: selectedModel,
                            input,
                            voice: mappedVoice,
                        };
                        if ( body?.instructions ) upstreamBody.instructions = body.instructions;
                        // Groq Orpheus only supports "wav"; force it to avoid 400 errors
                        const upstreamFormat = this.getUpstreamResponseFormat( config, body?.response_format );
                        if ( upstreamFormat ) upstreamBody.response_format = upstreamFormat;
                        if ( body?.speed != null ) upstreamBody.speed = body.speed;
                        if ( wantsStream && body?.stream_format ) upstreamBody.stream_format = body.stream_format;

                        console.info( `[${endpoint}] upstream_request provider=${config.id} model=${selectedModel} voice=${mappedVoice} characters=${characters} stream=${wantsStream}` );

                        const upstreamResponse = await fetchWithProxy( url, {
                            method: 'POST',
                            headers: {
                                'Authorization': `Bearer ${config.apiKey}`,
                                'Content-Type': 'application/json',
                                'User-Agent': 'ai-edge/1.0',
                            },
                            body: JSON.stringify( upstreamBody ),
                        }, CONFIG.proxy, { skipTimeout: wantsStream } );

                        backendCooldownManager.markFromStatus( config.id, selectedModel, upstreamResponse.status );

                        if ( upstreamResponse.status === 429 ) {
                            this.providerStats.recordFailure( config.id, selectedModel, Date.now() - requestStartedAt );
                            console.warn( `[${endpoint}] 429 from ${config.id}, trying next backend` );
                            break;
                        }

                        if ( !upstreamResponse.ok ) {
                            lastFailure = {
                                status: upstreamResponse.status,
                                payload: await this.parseResponsePayload( upstreamResponse ),
                            };
                            this.providerStats.recordFailure( config.id, selectedModel, Date.now() - requestStartedAt );
                            console.error( `[${endpoint}] ${upstreamResponse.status} from ${config?.id ?? config?.name}` );
                            break;
                        }

                        const upstreamContentType = upstreamResponse.headers.get( 'content-type' ) || 'application/octet-stream';

                        // Streaming response (SSE with audio chunks)
                        if ( wantsStream && upstreamContentType.includes( 'text/event-stream' ) ) {
                            console.info( `[${endpoint}] stream_start provider=${config.id} model=${selectedModel} characters=${characters}` );
                            this.providerStats.recordSuccess( config.id, selectedModel, Date.now() - requestStartedAt );
                            return this.proxyAudioStream( c, upstreamResponse, endpoint, config.id, selectedModel );
                        }

                        // Streaming audio (raw audio bytes, not SSE)
                        if ( wantsStream && upstreamResponse.body ) {
                            console.info( `[${endpoint}] audio_stream provider=${config.id} model=${selectedModel} characters=${characters}` );
                            this.providerStats.recordSuccess( config.id, selectedModel, Date.now() - requestStartedAt );

                            const responseFormat = upstreamBody.response_format || body?.response_format || 'mp3';
                            const mimeMap: Record<string, string> = {
                                mp3: 'audio/mpeg',
                                opus: 'audio/opus',
                                aac: 'audio/aac',
                                flac: 'audio/flac',
                                wav: 'audio/wav',
                                pcm: 'audio/pcm',
                            };
                            const contentType = mimeMap[responseFormat] || 'audio/mpeg';

                            // Pipe the audio stream directly to the client
                            const clientSignal = c.req.raw.signal;
                            let clientDisconnected = false;
                            const upstreamReader = upstreamResponse.body!.getReader();
                            const onClientAbort = () => {
                                clientDisconnected = true;
                                upstreamReader.cancel( 'client disconnected' ).catch( () => { } );
                            };
                            clientSignal.addEventListener( 'abort', onClientAbort, { once: true } );

                            const audioStream = new ReadableStream( {
                                start( controller ) {
                                    ( async () => {
                                        try {
                                            while ( !clientDisconnected ) {
                                                const { done, value } = await upstreamReader.read();
                                                if ( done ) break;
                                                if ( value ) controller.enqueue( value );
                                            }
                                        } catch ( err: any ) {
                                            if ( !clientDisconnected ) {
                                                console.error( `[${endpoint}] stream_error provider=${config.id}: ${err?.message}` );
                                            }
                                        } finally {
                                            clientSignal.removeEventListener( 'abort', onClientAbort );
                                            try { upstreamReader.releaseLock(); } catch { /* ignore */ }
                                            try { controller.close(); } catch { /* already closed */ }
                                        }
                                    } )();
                                },
                            } );

                            return new Response( audioStream, {
                                status: 200,
                                headers: {
                                    'Content-Type': contentType,
                                    'Transfer-Encoding': 'chunked',
                                    'Cache-Control': 'no-cache',
                                },
                            } );
                        }

                        // Non-streaming: read the full audio response and forward
                        const responseBuffer = await upstreamResponse.arrayBuffer();
                        // Use the format we actually sent upstream (may differ from client request)
                        const effectiveFormat = upstreamBody.response_format || body?.response_format || 'mp3';
                        const mimeMap: Record<string, string> = {
                            mp3: 'audio/mpeg',
                            opus: 'audio/opus',
                            aac: 'audio/aac',
                            flac: 'audio/flac',
                            wav: 'audio/wav',
                            pcm: 'audio/pcm',
                        };
                        const contentType = mimeMap[effectiveFormat] || 'audio/mpeg';

                        console.info( `[${endpoint}] success provider=${config.id} model=${selectedModel} characters=${characters} totalMs=${Date.now() - requestStartedAt}` );
                        this.providerStats.recordSuccess( config.id, selectedModel, Date.now() - requestStartedAt );

                        c.header( 'Content-Type', contentType );
                        return c.body( responseBuffer );
                    } catch ( error: any ) {
                        this.providerStats.recordFailure( config.id, selectedModel );
                        console.error( `[${endpoint}] error provider=${config.id} model=${selectedModel}: ${error?.message}` );
                        break;
                    }
                }
            }

            // All backends exhausted
            if ( lastFailure ) {
                return c.json( lastFailure.payload, lastFailure.status as any );
            }
            return c.json( { error: { message: 'All TTS backends failed', type: 'server_error' } }, 502 );
        } catch ( error: any ) {
            console.error( `[${endpoint}] request_error: ${error?.message}` );
            return c.json( { error: { message: error?.message || 'Internal error', type: 'server_error' } }, 500 );
        }
    }

    private async handleOpenAIRequest( c: Context, endpoint: string ) {
        const rawBody = await c.req.json().catch( () => ( {} ) );

        // Resolve skill & file references before any processing
        if ( isSkillResolverReady() ) {
            await resolveOpenAIBody( rawBody );
        }

        const normalizedBody = this.normalizeToolSearchForEndpoint( rawBody, endpoint );

        if ( this.shouldUseOpenAICodeInterpreter( normalizedBody ) ) {
            return this.proxyCodeInterpreterRequest( c, endpoint, normalizedBody );
        }

        // Convert Responses API body to chat/completions format for upstream backends
        if ( endpoint === 'responses' ) {
            // Intercept file_search tools: query vector store, inject context, strip tool
            const fileSearchContext = await this.prepareFileSearchForResponses( normalizedBody );
            const converted = convertResponsesRequestToChat( fileSearchContext.body );
            return this.proxyRequest( c, 'chat/completions', 1, converted, normalizedBody, fileSearchContext.searchCalls );
        }

        return this.proxyRequest( c, endpoint, 1, normalizedBody );
    }

    public normalizeToolSearchForEndpoint( body: any, endpoint: string ): any {
        if ( !Array.isArray( body?.tools ) ) {
            return body;
        }

        // Strip tool_search and defer_loading for all endpoints.
        // For the responses endpoint, built-in tools like file_search and
        // web_search_preview are still present in the tools array — they are
        // intercepted and handled by their respective managers, not forwarded.
        const normalizedTools = body.tools
            .filter( ( tool: any ) => tool?.type !== 'tool_search' )
            .map( ( tool: any ) => this.removeDeferLoadingField( tool ) );

        const changed = normalizedTools.length !== body.tools.length
            || normalizedTools.some( ( tool: any, index: number ) => tool !== body.tools[index] );

        if ( !changed ) {
            return body;
        }

        const normalizedBody: any = {
            ...body,
            tools: normalizedTools,
        };

        if ( this.toolChoicePointsToMissingTool( normalizedBody.tool_choice, normalizedTools ) ) {
            delete normalizedBody.tool_choice;
        }

        return normalizedBody;
    }

    private removeDeferLoadingField( tool: any ): any {
        if ( !tool || typeof tool !== 'object' ) {
            return tool;
        }

        let changed = false;
        const nextTool = { ...tool } as Record<string, any>;

        if ( Object.prototype.hasOwnProperty.call( nextTool, 'defer_loading' ) ) {
            delete nextTool.defer_loading;
            changed = true;
        }

        if ( nextTool.function && typeof nextTool.function === 'object' && !Array.isArray( nextTool.function ) ) {
            const fn = { ...nextTool.function } as Record<string, any>;
            if ( Object.prototype.hasOwnProperty.call( fn, 'defer_loading' ) ) {
                delete fn.defer_loading;
                nextTool.function = fn;
                changed = true;
            }
        }

        return changed ? nextTool : tool;
    }

    private toolChoicePointsToMissingTool( toolChoice: any, tools: any[] ): boolean {
        if ( !toolChoice || typeof toolChoice !== 'object' ) {
            return false;
        }

        const selectedName = toolChoice?.function?.name;
        if ( typeof selectedName !== 'string' || !selectedName ) {
            return false;
        }

        const available = new Set<string>();
        for ( const tool of tools ) {
            if ( typeof tool?.function?.name === 'string' && tool.function.name ) {
                available.add( tool.function.name );
                continue;
            }
            if ( typeof tool?.name === 'string' && tool.name ) {
                available.add( tool.name );
            }
        }

        return !available.has( selectedName );
    }

    private getEffectiveRateLimit( config: OpenAIModelConfig, selectedModel?: string ): Config['rateLimit'] | undefined {
        // Per-model rate limit (models array entries can carry their own
        // rateLimit — the gemini providers use this) takes precedence over
        // the provider-level / global limit.
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

    private async proxyRequest( c: Context, endpoint: string, redirectDepth: number = 1, rawBody?: any, originalResponsesBody?: any, fileSearchCalls?: FileSearchCallItem[] ): Promise<any> {
        const requestStartedAt = Date.now();
        let bodyParsedAt = requestStartedAt;
        let webSearchCompletedAt = requestStartedAt;
        let rateLimitCompletedAt = requestStartedAt;
        let upstreamRequestStartedAt = requestStartedAt;
        let upstreamResponseReceivedAt = requestStartedAt;
        const resolvedBody = rawBody ?? await c.req.json().catch( () => ( {} ) );
        bodyParsedAt = Date.now();
        const webSearchContext = await this.prepareWebSearchForOpenAI( resolvedBody, endpoint );
        webSearchCompletedAt = Date.now();
        if ( webSearchContext.errorResponse ) {
            return c.json( webSearchContext.errorResponse.body, webSearchContext.errorResponse.status as any );
        }

        const body = webSearchContext.body;
        const modelName = body.model;
        let lastFailure: { status: number; payload: any } | null = null;

        if ( !modelName || typeof modelName !== 'string' ) {
            return c.json( {
                error: {
                    message: 'Model is required and must be a string',
                    type: 'invalid_request_error'
                }
            }, 400 );
        }

        const maxRedirects = 5;
        if ( redirectDepth > maxRedirects ) {
            return c.json( {
                error: {
                    message: 'Maximum redirect depth exceeded',
                    type: 'invalid_request_error'
                }
            }, 400 );
        }

        // Track whether Codex expects SSE events (Responses API + streaming)
        // Note: endpoint is always 'chat/completions' when coming from the
        // Responses path (the body is converted before entering proxyRequest),
        // so we check originalResponsesBody instead.
        const isResponsesApi = !!originalResponsesBody;
        const originalStreamFlag = originalResponsesBody?.stream === true || body.stream === true;
        const isStreamingResponses = isResponsesApi && originalStreamFlag;

        const matchingBackends = this.getBackendsForModel( modelName, endpoint );
        if ( !matchingBackends.length ) {
            console.error( `[${endpoint}] No backends found for model: ${modelName}` );

            // For Responses API with streaming, Codex expects SSE events.
            // Return a proper Responses-format error via SSE so the client
            // doesn't hang waiting for `response.completed`.
            if ( isStreamingResponses ) {
                return this.sendResponsesStreamError( modelName, `Model not found: ${modelName}` );
            }

            // Responses API non-streaming: return JSON error.
            if ( originalResponsesBody ) {
                return c.json( {
                    error: { message: `Model not found: ${modelName}`, type: 'invalid_request_error' },
                }, 400 );
            }

            return c.json( {
                error: {
                    message: `Model not found: ${modelName}`,
                    type: 'invalid_request_error'
                }
            }, 400 );
        }

        const backends = this.getOptimizedBackends( modelName, endpoint, matchingBackends );
        const backendIds = backends.map( b => b.id ).join( ', ' );
        console.error( `[${endpoint}] Attempting backends for model ${modelName}: ${backendIds}` );

        // Two-pass attempt plan:
        //   Pass 1: the exact requested model across every in-group backend.
        //   Pass 2 (last resort): when pass 1 is fully consumed without a
        //   success, participating (randomRouting !== false) providers in the
        //   same group offer their best sibling models as substitution — the
        //   return benefit of taking part in random routing.
        const attempts: { config: OpenAIModelConfig; selectedModel: string }[] = [];
        for ( const config of backends ) {
            const candidateModels = this.getCandidateModelsForProvider( config, modelName );
            for ( const selectedModel of candidateModels ) {
                attempts.push( { config, selectedModel } );
            }
        }
        const isAutoEdgeRequest = this.isAutoModel( modelName )
            || !( CONFIG.models.openai ?? [] ).some( c => this.configHasModel( c, modelName ) );
        let attemptIdx = 0;
        let siblingPassAppended = false;

        while ( true ) {
            if ( attemptIdx >= attempts.length ) {
                // Pass 1 fully consumed and no success (success returns early).
                if ( !siblingPassAppended && !isAutoEdgeRequest ) {
                    siblingPassAppended = true;
                    console.error( `[${endpoint}] In-group backends exhausted for ${modelName} — sibling pass (random-routing participants)` );
                    for ( const config of backends ) {
                        const siblings = this.getCandidateModelsForProvider( config, modelName, true );
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

                const requestWithModel = { ...body, model: selectedModel };
                const withReasoning = this.withReasoningEffort( requestWithModel, config, selectedModel );
                const upstreamBodyRaw = this.isGeminiProvider( config )
                    ? this.ensureToolCallThoughtSignatures( this.withGeminiThinking( withReasoning, selectedModel ) )
                    : withReasoning;
                const upstreamBody = isStringContentOnlyProvider( config )
                    ? normalizeMessagesContentToString( upstreamBodyRaw )
                    : upstreamBodyRaw;

                const tokens = this.calculateTokenCount( upstreamBody );
                const rateLimit = this.getEffectiveRateLimit( config, selectedModel );
                // ── Preemptive TPM-meter hop ──
                // Gemini providers have very low tokens-per-minute limits. Peek
                // the token bucket BEFORE attempting upstream: if the meter
                // can't cover this request, hop to the next (provider, model)
                // turn immediately instead of burning an upstream call and
                // waiting for a 429. Turn-wise rotation + same-group isolation
                // stay intact; sibling substitution (pass 2) picks up when
                // every provider's exact-model meter is low.
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
                rateLimitCompletedAt = Date.now();

                if ( !rateCheck.allowed ) {
                    console.error( `[${endpoint}] Rate limit exceeded for ${config.id} - need ${tokens} tokens, limit: ${rateLimit?.tokensPerMinute || rateLimit?.requestsPerMinute || 'unknown'}/min` );
                    continue;
                }

                try {
                    const url = this.buildApiUrl( config, endpoint );
                    upstreamRequestStartedAt = Date.now();
                    if ( isDebugEnabled() ) {
                        console.info( `[${endpoint}] upstream_request model=${selectedModel} body=${JSON.stringify( redactForLog( upstreamBody ) )}` );
                    }

                    let response = await fetchWithProxy( url, {
                        method: 'POST',
                        headers: this.buildHeaders( config ),
                        body: JSON.stringify( upstreamBody ),
                    }, CONFIG.proxy, { skipTimeout: upstreamBody.stream === true } );
                    upstreamResponseReceivedAt = Date.now();

                    // A few OpenAI-compatible providers reject Codex's
                    // function-tool schema while accepting an otherwise
                    // identical Responses request. Retry once with optional
                    // tool controls removed so a plain turn can still start.
                    if ( response.status === 400 && isStreamingResponses && ( upstreamBody.tools || upstreamBody.tool_choice ) ) {
                        const compatibilityBody = { ...upstreamBody };
                        delete compatibilityBody.tools;
                        delete compatibilityBody.tool_choice;
                        console.warn( `[${endpoint}] 400 from ${config.id} model=${selectedModel} — retrying Codex stream without tools` );
                        response = await fetchWithProxy( url, {
                            method: 'POST',
                            headers: this.buildHeaders( config ),
                            body: JSON.stringify( compatibilityBody ),
                        }, CONFIG.proxy, { skipTimeout: true } );
                        upstreamResponseReceivedAt = Date.now();
                    }

                    backendCooldownManager.markFromStatus( config.id, selectedModel, response.status );
                    if ( response.status === 429 ) {
                        this.providerStats.recordFailure( config.id, selectedModel, upstreamResponseReceivedAt - upstreamRequestStartedAt );
                        continue;
                    }

                    if ( this.isRedirectStatus( response.status ) ) {
                        const location = response.headers.get( 'location' );
                        if ( location ) {
                            const redirectModel = this.extractModelFromLocation( location );
                            if ( redirectModel && redirectModel !== modelName ) {
                                return this.proxyRequest( c, endpoint, redirectDepth + 1, { ...body, model: redirectModel } );
                            }
                        }
                    }

                    // ── Non-2xx check for streaming ──
                    // Must come BEFORE the streaming block. When the upstream
                    // returns an error (401, 500, etc.) with stream=true, the
                    // response body is usually JSON, not SSE.  Without this
                    // check the proxy would try to parse the error as SSE and
                    // silently return empty output to the client.
                    if ( !response.ok ) {
                        lastFailure = {
                            status: response.status,
                            payload: await this.parseResponsePayload( response ),
                        };
                        this.providerStats.recordFailure( config.id, selectedModel, upstreamResponseReceivedAt - upstreamRequestStartedAt );
                        const upstreamMessage = lastFailure.payload?.error?.message
                            || lastFailure.payload?.message
                            || ( typeof lastFailure.payload === 'string' ? lastFailure.payload : undefined );
                        console.error( `[${endpoint}] ${response.status} from ${config?.id ?? config?.name} model=${selectedModel} — skipping streaming path${upstreamMessage ? `: ${String( upstreamMessage ).slice( 0, 300 )}` : ''}` );
                        // For streaming Responses API, emit SSE error so the
                        // client doesn't hang waiting for response.completed.
                        if ( isStreamingResponses ) {
                            return this.sendResponsesStreamError( selectedModel, lastFailure.payload?.error?.message || `Upstream returned ${response.status}` );
                        }
                        continue;
                    }

                    // Some upstreams return HTTP 200 with a JSON error body
                    // even when stream=true. Detect via content-type so we
                    // don't try to parse JSON as SSE.
                    const responseContentType = response.headers.get( 'content-type' ) ?? '';
                    if ( upstreamBody.stream === true && responseContentType.includes( 'application/json' ) ) {
                        const errorPayload = await this.parseResponsePayload( response );
                        if ( errorPayload?.type === 'error' || errorPayload?.error ) {
                            const errorMsg = errorPayload?.error?.message || errorPayload?.error || JSON.stringify( errorPayload );
                            lastFailure = {
                                status: 200,
                                payload: errorPayload,
                            };
                            this.providerStats.recordFailure( config.id, selectedModel, upstreamResponseReceivedAt - upstreamRequestStartedAt );
                            console.error( `[${endpoint}] upstream_error_in_body(stream) from ${config?.id ?? config?.name}: ${typeof errorMsg === 'string' ? errorMsg.slice( 0, 200 ) : JSON.stringify( errorMsg ).slice( 0, 200 )}` );
                            if ( originalResponsesBody ) {
                                return this.sendResponsesStreamError( selectedModel, typeof errorMsg === 'string' ? errorMsg : JSON.stringify( errorMsg ) );
                            }
                            continue;
                        }
                        // Non-error JSON response in streaming — unusual but
                        // fall through to let the normal non-streaming path
                        // handle it below.
                    }

                    // Handle streaming responses
                    if ( upstreamBody.stream === true ) {
                        c.header( 'Content-Type', 'text/event-stream' );
                        c.header( 'Transfer-Encoding', 'chunked' );
                        c.header( 'Cache-Control', 'no-cache, no-transform' );
                        c.header( 'Connection', 'keep-alive' );
                        c.header( 'X-Accel-Buffering', 'no' );
                        const serverTiming = formatTimingEntries( {
                            body_parse: bodyParsedAt - requestStartedAt,
                            web_search: webSearchCompletedAt - requestStartedAt,
                            rate_limit: rateLimitCompletedAt - requestStartedAt,
                            upstream: upstreamResponseReceivedAt - upstreamRequestStartedAt,
                            total: upstreamResponseReceivedAt - requestStartedAt,
                        } );
                        if ( serverTiming ) {
                            c.header( 'Server-Timing', serverTiming );
                        }

                        if ( response.body ) {
                            console.info( `[${endpoint}] stream_started provider=${config.id} model=${selectedModel} setupMs=${Date.now() - requestStartedAt} bodyParseMs=${bodyParsedAt - requestStartedAt} webSearchMs=${webSearchCompletedAt - requestStartedAt} rateLimitMs=${rateLimitCompletedAt - requestStartedAt} upstreamMs=${upstreamResponseReceivedAt - upstreamRequestStartedAt}` );
                            this.providerStats.recordSuccess( config.id, selectedModel, upstreamResponseReceivedAt - upstreamRequestStartedAt );

                            // Responses API: convert chat SSE chunks to Responses SSE format
                            if ( originalResponsesBody ) {
                                return this.streamResponsesConverted( c, response, originalResponsesBody, config.id, selectedModel, requestStartedAt, fileSearchCalls );
                            }

                            return stream( c, async ( streamWriter ) => {
                                const reader = response.body!.getReader();
                                const decoder = new TextDecoder();
                                let firstChunkLogged = false;
                                let clientDisconnected = false;
                                const heartbeat = startStreamHeartbeat(
                                    ( chunk ) => streamWriter.write( chunk ),
                                    { isClientConnected: () => !clientDisconnected }
                                );

                                const clientSignal = c.req.raw.signal;
                                const onClientAbort = () => {
                                    clientDisconnected = true;
                                    reader.cancel( 'client disconnected' ).catch( () => { } );
                                };
                                clientSignal.addEventListener( 'abort', onClientAbort, { once: true } );

                                try {
                                    while ( !clientDisconnected ) {
                                        const { done, value } = await reader.read();
                                        if ( done ) break;
                                        if ( value && !firstChunkLogged ) {
                                            firstChunkLogged = true;
                                            console.info( `[${endpoint}] stream_first_chunk provider=${config.id} model=${selectedModel} firstByteMs=${Date.now() - upstreamResponseReceivedAt}` );
                                        }
                                        if ( value ) {
                                            const chunk = decoder.decode( value, { stream: true } );
                                            if ( chunk ) {
                                                await streamWriter.write( this.normalizeGeminiSseChunk( chunk ) );
                                                heartbeat.kick();
                                            }
                                        }
                                    }

                                    if ( !clientDisconnected ) {
                                        const tail = decoder.decode();
                                        if ( tail ) {
                                            await streamWriter.write( this.normalizeGeminiSseChunk( tail ) );
                                        }
                                    }

                                    if ( !clientDisconnected ) {
                                        console.info( `[${endpoint}] stream_complete provider=${config.id} model=${selectedModel} totalMs=${Date.now() - requestStartedAt}` );
                                    }
                                } finally {
                                    heartbeat.stop();
                                    clientSignal.removeEventListener( 'abort', onClientAbort );
                                    try { reader.releaseLock(); } catch { /* ignore */ }
                                }
                            }, async ( err, streamWriter ) => {
                                console.error( `[${endpoint}] Streaming error: ${err?.message || String( err )}` );
                                await streamWriter.writeln( `data: ${JSON.stringify( {
                                    error: {
                                        message: err?.message || 'An error occurred during streaming',
                                        type: 'upstream_error',
                                    }
                                } )}\n` );
                            } );
                        }
                    }

                    const payload = await this.parseResponsePayload( response );
                    if ( isDebugEnabled() ) {
                        console.info( `[${endpoint}] upstream_response model=${selectedModel} status=${response.status} body=${JSON.stringify( redactForLog( payload ) )}` );
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

                    // Some upstreams return HTTP 200 with an error payload
                    // (e.g. {"type":"error","error":{"type":"ModelError",...}}).
                    // Detect and treat as a failure so we try the next backend.
                    if ( payload?.type === 'error' || ( payload?.error && !payload?.choices ) ) {
                        const errorMsg = payload?.error?.message || payload?.error || JSON.stringify( payload );
                        lastFailure = {
                            status: 200,
                            payload,
                        };
                        this.providerStats.recordFailure( config.id, selectedModel, upstreamResponseReceivedAt - upstreamRequestStartedAt );
                        console.error( `[${endpoint}] upstream_error_in_body from ${config?.id ?? config?.name}: ${typeof errorMsg === 'string' ? errorMsg.slice( 0, 200 ) : JSON.stringify( errorMsg ).slice( 0, 200 )}` );
                        continue;
                    }

                    // Convert chat/completions response back to Responses format if needed
                    let finalPayload = payload;
                    if ( originalResponsesBody ) {
                        finalPayload = convertChatResponseToResponses( finalPayload, originalResponsesBody, fileSearchCalls );
                        // Ensure usage is present using chat body for token counting (Responses payload has responses-format usage)
                        finalPayload = this.attachUsageIfMissing( 'responses', originalResponsesBody, finalPayload );
                        if ( isDebugEnabled() ) {
                            console.info( `[responses→chat] converted_response body=${JSON.stringify( redactForLog( finalPayload ) )}` );
                        }
                    } else {
                        finalPayload = this.attachUsageIfMissing( endpoint, upstreamBody, finalPayload );
                    }
                    const transformMs = Date.now() - upstreamResponseReceivedAt;
                    const totalMs = Date.now() - requestStartedAt;
                    const serverTiming = formatTimingEntries( {
                        body_parse: bodyParsedAt - requestStartedAt,
                        web_search: webSearchCompletedAt - requestStartedAt,
                        rate_limit: rateLimitCompletedAt - requestStartedAt,
                        upstream: upstreamResponseReceivedAt - upstreamRequestStartedAt,
                        transform: transformMs,
                        total: totalMs,
                    } );
                    if ( serverTiming ) {
                        c.header( 'Server-Timing', serverTiming );
                    }
                    console.info( `[${endpoint}] success provider=${config.id} model=${selectedModel} bodyParseMs=${bodyParsedAt - requestStartedAt} webSearchMs=${webSearchCompletedAt - requestStartedAt} rateLimitMs=${rateLimitCompletedAt - requestStartedAt} upstreamMs=${upstreamResponseReceivedAt - upstreamRequestStartedAt} transformMs=${transformMs} totalMs=${totalMs}` );
                    this.providerStats.recordSuccess( config.id, selectedModel, upstreamResponseReceivedAt - upstreamRequestStartedAt );
                    return c.json( this.attachWebSearchMetadata( originalResponsesBody ? 'responses' : endpoint, finalPayload, webSearchContext.searchResponse ), response.status as any );
                } catch ( error: any ) {
                    this.providerStats.recordFailure( config.id, selectedModel );
                    lastFailure = {
                        status: 502,
                        payload: {
                            error: {
                                message: error?.message || 'Upstream request failed',
                                type: 'upstream_error'
                            }
                        }
                    };
                    console.error( `[${endpoint}] Exception from ${config?.id ?? config?.name}: ${error?.message || String( error )}` );
                    continue;
                }
            }

        if ( lastFailure ) {
            const errorPayload = typeof lastFailure.payload === 'object' ? JSON.stringify( lastFailure.payload ) : String( lastFailure.payload );
            console.error( `\n❌ [${endpoint}] FINAL FAILURE (${lastFailure.status})\nAttempted backends: ${backends.map( b => b.id ).join( ', ' )}\nError: ${errorPayload}\n` );
            console.info( `[${endpoint}] failed totalMs=${Date.now() - requestStartedAt} bodyParseMs=${bodyParsedAt - requestStartedAt} webSearchMs=${webSearchCompletedAt - requestStartedAt} rateLimitMs=${rateLimitCompletedAt - requestStartedAt}` );

            // Responses API streaming: return SSE error so client doesn't hang.
            if ( isStreamingResponses ) {
                return this.sendResponsesStreamError( modelName, typeof lastFailure.payload === 'object' ? lastFailure.payload?.error?.message || JSON.stringify( lastFailure.payload ) : String( lastFailure.payload ) );
            }

            // Responses API non-streaming: return JSON error.
            if ( originalResponsesBody ) {
                return c.json( {
                    error: {
                        message: typeof lastFailure.payload === 'object' ? lastFailure.payload?.error?.message || 'Upstream request failed' : String( lastFailure.payload ),
                        type: 'upstream_error',
                    },
                }, 502 );
            }

            return this.sendFailurePayload( c, lastFailure.status, lastFailure.payload );
        }

        console.error( `\n❌ [${endpoint}] ALL PROVIDERS FAILED - No response from any backend\nModel: ${modelName}\nAttempted: ${backends.map( b => b.id ).join( ', ' )}\n` );
        console.info( `[${endpoint}] failed totalMs=${Date.now() - requestStartedAt} bodyParseMs=${bodyParsedAt - requestStartedAt} webSearchMs=${webSearchCompletedAt - requestStartedAt} rateLimitMs=${rateLimitCompletedAt - requestStartedAt}` );

        // Responses API streaming: return SSE error so client doesn't hang.
        if ( isStreamingResponses ) {
            return this.sendResponsesStreamError( modelName, 'All providers failed' );
        }

        // Responses API non-streaming: return JSON error.
        if ( originalResponsesBody ) {
            return c.json( {
                error: {
                    message: 'All providers failed',
                    type: 'upstream_error',
                },
            }, 502 );
        }

        return c.json( {
            error: {
                message: 'All providers failed',
                type: 'internal_error'
            }
        }, 502 );
    }

    private async prepareWebSearchForOpenAI( body: any, endpoint: string ): Promise<{
        body: any;
        searchResponse?: WebSearchResponse;
        errorResponse?: { status: number; body: any };
    }> {
        const startedAt = Date.now();
        if ( !this.shouldUseOpenAIWebSearch( body ) ) {
            return { body };
        }

        if ( !webSearchManager.isEnabled() ) {
            return {
                body,
                errorResponse: {
                    status: 503,
                    body: {
                        error: {
                            message: 'Web search requested but no web search provider is configured',
                            type: 'invalid_request_error',
                        }
                    }
                }
            };
        }

        const query = this.extractOpenAIWebSearchQuery( body, endpoint );
        if ( !query ) {
            return {
                body,
                errorResponse: {
                    status: 400,
                    body: {
                        error: {
                            message: 'Unable to derive a web search query from the request',
                            type: 'invalid_request_error',
                        }
                    }
                }
            };
        }

        const searchDefaults = CONFIG.tools?.webSearch?.defaults;
        const searchResponse = await webSearchManager.search( query, {
            maxResults: searchDefaults?.maxResults ?? 6,
            expand: searchDefaults?.expandQueries,
            maxExpandedQueries: searchDefaults?.maxExpandedQueries,
            parallelQueries: searchDefaults?.parallelQueries,
            softTimeoutMs: searchDefaults?.softTimeoutMs,
            providerTimeoutMs: searchDefaults?.providerTimeoutMs,
        } );
        console.info( `[web-search] openai_prepare endpoint=${endpoint} durationMs=${Date.now() - startedAt} provider=${searchResponse.provider} cached=${searchResponse.cached} citations=${searchResponse.citations.length}` );
        return {
            body: this.injectOpenAIWebSearchContext( body, endpoint, searchResponse ),
            searchResponse,
        };
    }

    private shouldUseOpenAIWebSearch( body: any ): boolean {
        const tools = Array.isArray( body?.tools ) ? body.tools : [];
        return tools.some( ( tool: any ) => tool?.type === 'web_search' || tool?.type === 'web_search_preview' );
    }

    private extractOpenAIWebSearchQuery( body: any, endpoint: string ): string | null {
        if ( endpoint === 'responses' ) {
            const values = this.collectTokenStrings( body?.input );
            return values.join( ' ' ).trim() || null;
        }

        if ( endpoint === 'chat/completions' ) {
            const messages = Array.isArray( body?.messages ) ? body.messages : [];
            for ( let index = messages.length - 1; index >= 0; index -= 1 ) {
                const message = messages[index];
                if ( message?.role !== 'user' ) continue;
                const values = this.collectTokenStrings( message?.content );
                const text = values.join( ' ' ).trim();
                if ( text ) return text;
            }
        }

        return null;
    }

    private injectOpenAIWebSearchContext( body: any, endpoint: string, searchResponse: WebSearchResponse ): any {
        const toolFreeBody = {
            ...body,
            tools: Array.isArray( body?.tools )
                ? body.tools.filter( ( tool: any ) => tool?.type !== 'web_search' && tool?.type !== 'web_search_preview' )
                : body?.tools,
        };
        const searchPrompt = this.buildOpenAIWebSearchPrompt( searchResponse );

        if ( endpoint === 'responses' ) {
            return {
                ...toolFreeBody,
                input: [
                    ...( Array.isArray( toolFreeBody.input ) ? toolFreeBody.input : [toolFreeBody.input].filter( Boolean ) ),
                    {
                        role: 'system',
                        content: [
                            {
                                type: 'input_text',
                                text: searchPrompt,
                            }
                        ],
                    },
                ],
            };
        }

        if ( endpoint === 'chat/completions' ) {
            return {
                ...toolFreeBody,
                messages: [
                    {
                        role: 'system',
                        content: searchPrompt,
                    },
                    ...( Array.isArray( toolFreeBody.messages ) ? toolFreeBody.messages : [] ),
                ],
            };
        }

        return toolFreeBody;
    }

    private buildOpenAIWebSearchPrompt( searchResponse: WebSearchResponse ): string {
        const citations = searchResponse.citations
            .map( ( citation, index ) => `[${index + 1}] ${citation.title} - ${citation.url}\n${citation.snippet}` )
            .join( '\n\n' );

        return [
            `Web search results for query: ${searchResponse.query}`,
            'Use these sources when answering. Cite them inline as [1], [2], etc when relevant.',
            citations,
        ].join( '\n\n' );
    }

    private attachWebSearchMetadata( endpoint: string, payload: any, searchResponse?: WebSearchResponse ): any {
        if ( !searchResponse || !payload || typeof payload !== 'object' || Array.isArray( payload ) ) {
            return payload;
        }

        if ( endpoint === 'responses' ) {
            const output = Array.isArray( payload.output ) ? payload.output : [];
            return {
                ...payload,
                output: [
                    {
                        type: 'web_search_call',
                        id: `ws_${Date.now().toString( 36 )}`,
                        status: 'completed',
                        action: {
                            type: 'search',
                            query: searchResponse.query,
                        },
                    },
                    ...output,
                ],
                web_search: {
                    provider: searchResponse.provider,
                    citations: searchResponse.citations,
                    cached: searchResponse.cached,
                },
            };
        }

        return {
            ...payload,
            web_search: {
                provider: searchResponse.provider,
                citations: searchResponse.citations,
                cached: searchResponse.cached,
            },
        };
    }

    private async prepareFileSearchForResponses( body: any ): Promise<{
        body: any;
        searchCalls?: FileSearchCallItem[];
    }> {
        if ( !this.shouldUseFileSearch( body ) ) {
            return { body };
        }

        if ( !fileSearchManager.isEnabled() ) {
            console.warn( `[file-search] file_search tool requested but vector store is not configured — stripping tool` );
            return { body: this.stripFileSearchTools( body ) };
        }

        const tools = Array.isArray( body?.tools ) ? body.tools : [];
        const fileSearchTools = tools.filter( ( t: any ) => t?.type === 'file_search' );

        const queries = this.extractFileSearchQueries( body );
        if ( !queries.length ) {
            console.warn( `[file-search] No queries derivable from input — stripping file_search tool` );
            return { body: this.stripFileSearchTools( body ) };
        }

        // Collect all vector store IDs across all file_search tools
        const vectorStoreIds: string[] = [];
        for ( const tool of fileSearchTools ) {
            const ids = Array.isArray( tool.vector_store_ids ) ? tool.vector_store_ids : [];
            for ( const id of ids ) {
                if ( typeof id === 'string' && !vectorStoreIds.includes( id ) ) {
                    vectorStoreIds.push( id );
                }
            }
        }

        const maxResults = Math.max(
            ...fileSearchTools.map( ( t: any ) => t?.max_num_results ?? 20 ),
            20,
        );

        try {
            const searchResponse = await fileSearchManager.search( queries, vectorStoreIds, { maxResults } );
            const searchCallId = `fs_${Date.now().toString( 36 )}`;
            const searchCall: FileSearchCallItem = {
                id: searchCallId,
                queries,
                status: 'completed',
                results: searchResponse.results,
            };

            // Inject search results as context and strip file_search tools
            const enrichedBody = this.injectFileSearchContext( this.stripFileSearchTools( body ), queries, searchResponse );
            return { body: enrichedBody, searchCalls: [searchCall] };
        } catch ( err: any ) {
            console.error( `[file-search] search_error error=${err?.message || String( err )}` );
            return { body: this.stripFileSearchTools( body ) };
        }
    }

    private shouldUseFileSearch( body: any ): boolean {
        const tools = Array.isArray( body?.tools ) ? body.tools : [];
        return tools.some( ( tool: any ) => tool?.type === 'file_search' );
    }

    private extractFileSearchQueries( body: any ): string[] {
        // Derive queries from the input messages (last user message)
        const inputItems = Array.isArray( body?.input ) ? body.input : ( body?.input ? [body.input] : [] );
        const queries: string[] = [];

        for ( let i = inputItems.length - 1; i >= 0; i-- ) {
            const item = inputItems[i];
            if ( !item || typeof item !== 'object' ) continue;

            // EasyInputMessage / Message format
            if ( item.role === 'user' || item.role === 'developer' ) {
                const text = this.collectTextFromContent( item.content );
                if ( text ) {
                    queries.push( text );
                    break;
                }
            }
        }

        // Fallback: try to extract any text from all input items
        if ( !queries.length ) {
            for ( const item of inputItems ) {
                if ( !item || typeof item !== 'object' ) continue;
                const text = this.collectTextFromContent( item.content );
                if ( text ) {
                    queries.push( text );
                    break;
                }
            }
        }

        return queries.slice( 0, 5 );
    }

    private collectTextFromContent( content: unknown ): string {
        if ( typeof content === 'string' ) return content.trim();
        if ( !Array.isArray( content ) ) return '';
        const parts: string[] = [];
        for ( const block of content ) {
            if ( !block || typeof block !== 'object' ) continue;
            const t = block.type as string;
            if ( ( t === 'input_text' || t === 'text' ) && typeof block.text === 'string' ) {
                parts.push( block.text );
            } else if ( typeof block.text === 'string' ) {
                parts.push( block.text );
            }
        }
        return parts.join( '\n' ).trim();
    }

    private stripFileSearchTools( body: any ): any {
        if ( !Array.isArray( body?.tools ) ) return body;
        return {
            ...body,
            tools: body.tools.filter( ( t: any ) => t?.type !== 'file_search' ),
        };
    }

    private injectFileSearchContext( body: any, queries: string[], searchResponse: FileSearchResponse ): any {
        const snippets = searchResponse.results.map( ( r, i ) => {
            const fileRef = r.filename ? `[File: ${r.filename}]` : `[File ID: ${r.file_id}]`;
            const score = typeof r.score === 'number' ? ` (score: ${r.score.toFixed( 2 )})` : '';
            return `${fileRef}${score}\n${r.text}`;
        } );

        const fileSearchContext = [
            `File search results for query: ${queries.join( '; ' )}`,
            'Use these file excerpts as context when answering. Cite sources by filename when relevant.',
            snippets.join( '\n\n---\n\n' ),
        ].join( '\n\n' );

        // For Responses API: inject as a system message in the input array
        const inputItems = Array.isArray( body?.input )
            ? [...body.input]
            : ( body?.input ? [body.input] : [] );

        inputItems.push( {
            role: 'system',
            content: [
                {
                    type: 'input_text',
                    text: fileSearchContext,
                },
            ],
        } );

        return { ...body, input: inputItems };
    }

    private attachFileSearchMetadata( payload: any, searchCalls?: FileSearchCallItem[] ): any {
        if ( !searchCalls || !searchCalls.length || !payload || typeof payload !== 'object' || Array.isArray( payload ) ) {
            return payload;
        }

        const output = Array.isArray( payload.output ) ? payload.output : [];
        const fscItems = searchCalls.map( fc => ( {
            type: 'file_search_call',
            id: fc.id,
            status: fc.status,
            queries: fc.queries,
            ...( fc.results ? { results: fc.results } : {} ),
        } ) );

        return {
            ...payload,
            output: [...fscItems, ...output],
        };
    }

    private shouldUseOpenAICodeInterpreter( body: any ): boolean {
        if ( !codeInterpreterManager.isEnabled() ) {
            return false;
        }

        const tools = Array.isArray( body?.tools ) ? body.tools : [];
        return tools.some( ( tool: any ) => isCodeInterpreterTool( tool ) );
    }

    private async proxyCodeInterpreterRequest( c: Context, endpoint: string, rawBody: any ): Promise<any> {
        const webSearchContext = await this.prepareWebSearchForOpenAI( rawBody, endpoint );
        if ( webSearchContext.errorResponse ) {
            return c.json( webSearchContext.errorResponse.body, webSearchContext.errorResponse.status as any );
        }

        const body = webSearchContext.body;
        const modelName = body.model;
        let lastFailure: { status: number; payload: any } | null = null;

        if ( body.stream === true ) {
            return c.json( {
                error: {
                    message: 'code_interpreter does not currently support streaming responses',
                    type: 'invalid_request_error'
                }
            }, 400 );
        }

        if ( !modelName || typeof modelName !== 'string' ) {
            return c.json( {
                error: {
                    message: 'Model is required and must be a string',
                    type: 'invalid_request_error'
                }
            }, 400 );
        }

        const matchingBackends = this.getBackendsForModel( modelName, endpoint );
        if ( !matchingBackends.length ) {
            console.error( `[${endpoint}] No backends found for model: ${modelName}` );
            return c.json( {
                error: {
                    message: `Model not found: ${modelName}`,
                    type: 'invalid_request_error'
                }
            }, 400 );
        }

        const backends = this.getRoundRobinBackends( modelName, matchingBackends );
        const backendIds = backends.map( b => b.id ).join( ', ' );
        console.error( `[${endpoint}] Attempting code interpreter backends for model ${modelName}: ${backendIds}` );

        for ( const config of backends ) {
            const candidateModels = this.getCandidateModelsForProvider( config, modelName );

            for ( const selectedModel of candidateModels ) {
                const cooldownRemainingMs = backendCooldownManager.getRemainingMs( config.id, selectedModel );
                if ( cooldownRemainingMs > 0 ) {
                    console.warn( `[${endpoint}] cooldown_active provider=${config.id} model=${selectedModel} remainingMs=${cooldownRemainingMs}` );
                    continue;
                }

                try {
                    const { payload } = await this.runCodeInterpreterFlow( config, body, endpoint, selectedModel );
                    const enrichedPayload = this.attachUsageIfMissing( endpoint, body, payload );
                    return c.json( this.attachWebSearchMetadata( endpoint, enrichedPayload, webSearchContext.searchResponse ), 200 );
                } catch ( error: any ) {
                    if ( error?.rateLimitExceeded ) {
                        continue;
                    }

                    lastFailure = {
                        status: error?.status ?? 502,
                        payload: error?.payload ?? {
                            error: {
                                message: error?.message || 'Upstream request failed',
                                type: 'upstream_error'
                            }
                        }
                    };
                    console.error( `[${endpoint}] Code interpreter error from ${config?.id ?? config?.name}: ${error?.message || String( error )}` );
                    break;
                }
            }
        }

        if ( lastFailure ) {
            const errorPayload = typeof lastFailure.payload === 'object' ? JSON.stringify( lastFailure.payload ) : String( lastFailure.payload );
            console.error( `\n❌ [${endpoint}] FINAL FAILURE (${lastFailure.status})\nAttempted backends: ${backends.map( b => b.id ).join( ', ' )}\nError: ${errorPayload}\n` );
            return this.sendFailurePayload( c, lastFailure.status, lastFailure.payload );
        }

        console.error( `\n❌ [${endpoint}] ALL PROVIDERS FAILED - No response from any backend\nModel: ${modelName}\nAttempted: ${backends.map( b => b.id ).join( ', ' )}\n` );
        return c.json( {
            error: {
                message: 'All providers failed',
                type: 'internal_error'
            }
        }, 502 );
    }

    private async runCodeInterpreterFlow( config: OpenAIModelConfig, body: any, endpoint: string, selectedModel: string ): Promise<{ payload: any }> {
        const { request: chatRequest, responseMode } = this.normalizeCodeInterpreterRequest( body, endpoint, selectedModel );
        const chatRequestWithReasoning = this.ensureToolCallThoughtSignatures(
            this.withReasoningEffort( chatRequest, config, selectedModel )
        );
        const { tools } = stripCodeInterpreterTools( chatRequestWithReasoning.tools );
        const toolDefinition = buildCodeInterpreterToolDefinition();
        const toolChoice = normalizeToolChoice( body.tool_choice );
        const rateLimit = this.getEffectiveRateLimit( config, selectedModel );
        const upstreamEndpoint = 'chat/completions';
        const sessionId = this.resolveCodeInterpreterSessionId( body );

        const callModel = async ( request: any ) => {
            const url = this.buildApiUrl( config, upstreamEndpoint );
            if ( isDebugEnabled() ) {
                console.info( `[${upstreamEndpoint}] upstream_request model=${request?.model ?? selectedModel} body=${JSON.stringify( redactForLog( request ) )}` );
            }

            const response = await fetchWithProxy( url, {
                method: 'POST',
                headers: this.buildHeaders( config ),
                body: JSON.stringify( request ),
            }, CONFIG.proxy );
            const payload = await this.parseResponsePayload( response );
            if ( isDebugEnabled() ) {
                console.info( `[${upstreamEndpoint}] upstream_response model=${request?.model ?? selectedModel} status=${response.status} body=${JSON.stringify( redactForLog( payload ) )}` );
            }

            if ( !response.ok ) {
                const cooldownModel = typeof request?.model === 'string' ? request.model : selectedModel;
                backendCooldownManager.markFromStatus( config.id, cooldownModel, response.status );
                const error = new Error( `Upstream request failed with ${response.status}` );
                ( error as any ).status = response.status;
                ( error as any ).payload = payload;
                throw error;
            }

            return { response, payload };
        };

        const onBeforeRequest = async ( request: any ) => {
            const tokens = this.calculateTokenCount( request );
            const rateCheck = await rateLimitManager.checkAndConsume(
                config.id,
                tokens,
                rateLimit,
                selectedModel
            );

            if ( !rateCheck.allowed ) {
                const error = new Error( 'Rate limit exceeded' );
                ( error as any ).rateLimitExceeded = true;
                throw error;
            }
        };

        const { payload, toolRuns } = await runCodeInterpreterToolLoop( {
            request: {
                ...chatRequestWithReasoning,
                tools,
            },
            toolDefinition,
            toolChoice,
            callModel,
            onBeforeRequest,
            executeCode: async ( code, toolSessionId ) => codeInterpreterManager.executePython( code, toolSessionId ),
            sessionId,
        } );

        if ( responseMode === 'responses' ) {
            return {
                payload: this.buildResponsesPayloadFromChat( body, payload, toolRuns ),
            };
        }

        return { payload };
    }

    private normalizeCodeInterpreterRequest( body: any, endpoint: string, selectedModel: string ): { request: any; responseMode: 'chat' | 'responses' } {
        if ( endpoint === 'chat/completions' ) {
            return {
                request: {
                    ...body,
                    model: selectedModel,
                    stream: false,
                    reasoning_effort: body.reasoning_effort,
                    reasoning: body.reasoning,
                },
                responseMode: 'chat',
            };
        }

        const inputText = this.collectTokenStrings( body?.input ).join( ' ' ).trim();
        const instructionsText = this.collectTokenStrings( body?.instructions ).join( ' ' ).trim();
        const messages = [] as Array<{ role: string; content: string }>;

        if ( instructionsText ) {
            messages.push( {
                role: 'system',
                content: instructionsText,
            } );
        }

        if ( inputText ) {
            messages.push( {
                role: 'user',
                content: inputText,
            } );
        }

        return {
            request: {
                model: selectedModel,
                messages,
                temperature: body.temperature,
                top_p: body.top_p,
                max_tokens: body.max_output_tokens ?? body.max_tokens,
                presence_penalty: body.presence_penalty,
                frequency_penalty: body.frequency_penalty,
                seed: body.seed,
                stop: body.stop,
                stream: false,
                tools: body.tools,
                tool_choice: body.tool_choice,
                reasoning_effort: body.reasoning_effort,
                reasoning: body.reasoning,
            },
            responseMode: 'responses',
        };
    }

    private buildResponsesPayloadFromChat( requestBody: any, chatResponse: any, toolRuns: CodeInterpreterToolRun[] ): any {
        const output: any[] = [];

        for ( const run of toolRuns ) {
            output.push( this.buildCodeInterpreterCallOutput( run ) );
        }

        const messageText = chatResponse?.choices?.[0]?.message?.content ?? '';
        output.push( {
            type: 'message',
            id: `msg_${Date.now().toString( 36 )}`,
            role: 'assistant',
            content: messageText
                ? [
                    {
                        type: 'output_text',
                        text: messageText,
                        annotations: [],
                        phase: 'final',
                    }
                ]
                : [],
        } );

        const usage = chatResponse?.usage
            ? {
                input_tokens: chatResponse.usage.prompt_tokens ?? 0,
                output_tokens: chatResponse.usage.completion_tokens ?? 0,
                total_tokens: chatResponse.usage.total_tokens
                    ?? ( ( chatResponse.usage.prompt_tokens ?? 0 ) + ( chatResponse.usage.completion_tokens ?? 0 ) ),
            }
            : this.buildUsageForEndpoint( 'responses', requestBody, { output } );

        return {
            id: `resp_${Date.now().toString( 36 )}`,
            object: 'response',
            created: Math.floor( Date.now() / 1000 ),
            model: requestBody.model,
            output,
            usage,
        };
    }

    private buildCodeInterpreterCallOutput( run: CodeInterpreterToolRun ): any {
        const logs = run.stderr || run.stdout || '';
        return {
            type: 'code_interpreter_call',
            id: run.id || `ci_${Date.now().toString( 36 )}`,
            code: run.code,
            status: run.exitCode === 0 ? 'completed' : 'failed',
            outputs: [
                {
                    type: 'logs',
                    logs,
                }
            ],
        };
    }

    private resolveCodeInterpreterSessionId( body: any ): string {
        if ( typeof body?.container === 'string' ) {
            return body.container;
        }

        const tools = Array.isArray( body?.tools ) ? body.tools : [];
        for ( const tool of tools ) {
            if ( typeof tool?.container === 'string' ) {
                return tool.container;
            }
            if ( typeof tool?.container?.id === 'string' ) {
                return tool.container.id;
            }
        }

        return `ci_${Date.now().toString( 36 )}_${Math.random().toString( 36 ).slice( 2, 8 )}`;
    }

    private isRedirectStatus( status: number ): boolean {
        return [301, 302, 303, 307, 308].includes( status );
    }

    private extractModelFromLocation( location: string ): string | null {
        try {
            if ( location.includes( 'kilo-auto/' ) ) {
                const match = location.match( /kilo-auto\/([^/]+)/ );
                if ( match ) {
                    return `kilo-auto/${match[1]}`;
                }
            }
            const parts = location.split( '/' );
            const lastPart = parts[parts.length - 1];
            if ( lastPart && lastPart.length > 0 ) {
                return lastPart;
            }
        } catch {
            return null;
        }
        return null;
    }

    private getBackendsForModel( modelName: string, endpoint?: string, targetGroup?: string ): OpenAIModelConfig[] {
        const effectiveGroup = targetGroup || 'default';
        const cacheKey = `${modelName}|${endpoint ?? ''}|${effectiveGroup}`;
        const cached = this.backendRouteCache.get( cacheKey );
        if ( cached ) {
            return cached;
        }

        const configs = CONFIG.models.openai ?? [];
        const explicitlyAuto = this.isAutoModel( modelName );
        const modelIsListed = configs.some( config =>
            this.configHasModel( config, modelName )
        );
        // Unlisted models are treated as auto-edge: route through all available backends.
        const isAutoModel = explicitlyAuto || !modelIsListed;

        const exactBackends: OpenAIModelConfig[] = [];
        const fallbackBackends: OpenAIModelConfig[] = [];

        for ( const config of configs ) {
            const matchesRequestedModel = this.configHasModel( config, modelName );

            // Group isolation: only applies to auto-edge (fallback) routing.
            // Explicit model requests always gather all providers regardless of group.
            if ( isAutoModel && ( config as any ).groupSpace !== effectiveGroup ) continue;

            const canRouteWithoutModelMatch = ( isAutoModel || config.randomRouting !== false ) && !matchesRequestedModel;

            // For capability-specific endpoints, only consider providers that explicitly support them.
            // image_generation / image_editing providers must never serve text chat.
            if ( endpoint === 'embeddings' ) {
                if ( !this.isEmbeddingsEnabled( config ) ) continue;
            } else if ( endpoint === 'audio/transcriptions' || endpoint === 'audio/translations' ) {
                if ( !this.isSttEnabled( config ) ) continue;
            } else if ( endpoint === 'audio/speech' ) {
                if ( !this.isTtsEnabled( config ) ) continue;
            } else if ( endpoint === 'images/generations' ) {
                if ( !this.isImageGenerationEnabled( config ) ) continue;
            } else if ( endpoint === 'images/edits' ) {
                if ( !this.isImageEditingEnabled( config ) ) continue;
            } else {
                // chat/completions, completions, responses, and default/undefined → text only
                if ( this.isSttOrImageOnlyConfig( config ) || this.isEmbeddingsEnabled( config ) ) continue;
            }

            if ( matchesRequestedModel ) {
                exactBackends.push( config );
            } else if ( canRouteWithoutModelMatch ) {
                fallbackBackends.push( config );
            }
        }

        const result = isAutoModel
            ? fallbackBackends
            : modelIsListed
                ? [
                    ...exactBackends,
                    // Fallback stays group-scoped: only fall back to providers in
                    // the same groupSpace as an exact-match provider. Otherwise a
                    // gemini-group request would leak into the default group (and
                    // vice versa) when the primary backend fails.
                    ...fallbackBackends.filter( fb => {
                        const fbGroup = ( fb as any ).groupSpace || 'default';
                        return exactBackends.some( eb => ( ( eb as any ).groupSpace || 'default' ) === fbGroup );
                    } )
                  ]
                : fallbackBackends;

        // Deduplicate by baseUrl+apiKey so multiple API keys for the same
        // provider survive as separate backends (allowing in-group fallback
        // across keys) while identical endpoints+keys aren't retried in a
        // single request.
        const deduped = this.dedupeBackendsByBaseUrl( result ).slice( 0, OpenAIProxy.MAX_FALLBACK_BACKENDS );

        if ( this.backendRouteCache.size > OpenAIProxy.MAX_CACHE_SIZE ) {
            const firstKey = this.backendRouteCache.keys().next().value;
            if ( firstKey ) {
                this.backendRouteCache.delete( firstKey );
            }
        }
        this.backendRouteCache.set( cacheKey, deduped );
        return deduped;
    }

    private dedupeBackendsByBaseUrl( backends: OpenAIModelConfig[] ): OpenAIModelConfig[] {
        if ( backends.length <= 1 ) return backends;
        const seen = new Map<string, OpenAIModelConfig>();
        for ( const config of backends ) {
            // Composite key: baseUrl + apiKey prefix. Keeps different API keys
            // for the same upstream as separate backends (so e.g. gemini-1..6
            // stay distinct for in-group fallback) while collapsing exact
            // duplicates.
            const baseUrl = ( config.baseUrl ?? '' ).replace( /\/+$/, '' ).toLowerCase();
            const apiKey = ( config.apiKey ?? '' ).substring( 0, 12 );
            const key = `${baseUrl}::${apiKey}`;
            if ( !key || key === '::' ) {
                const fallbackKey = `id:${config.id}`;
                if ( !seen.has( fallbackKey ) ) seen.set( fallbackKey, config );
                continue;
            }
            if ( !seen.has( key ) ) seen.set( key, config );
        }
        return Array.from( seen.values() );
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

    private isImageGenerationEnabled( config: OpenAIModelConfig ): boolean {
        const imageModels = config.imageModels;
        return typeof imageModels === 'object' && imageModels?.image_generation === true;
    }

    private isEmbeddingsEnabled( config: OpenAIModelConfig ): boolean {
        return config.embeddings === true;
    }

    private isImageEditingEnabled( config: OpenAIModelConfig ): boolean {
        const imageModels = config.imageModels;
        return typeof imageModels === 'object' && imageModels?.image_editing === true;
    }

    private isImageOnlyConfig( config: OpenAIModelConfig ): boolean {
        const imageModels = config.imageModels;
        if ( typeof imageModels === 'boolean' ) {
            return imageModels;
        }
        return imageModels?.image_generation === true || imageModels?.image_editing === true;
    }

    private normalizeGeminiSseChunk( chunk: string ): string {
        return chunk.split( /(?<=\n)/ ).map( line => {
            if ( !line.startsWith( 'data: ' ) || line.trim() === 'data: [DONE]' ) return line;
            try {
                const payload = JSON.parse( line.slice( 6 ) );
                for ( const choice of Array.isArray( payload?.choices ) ? payload.choices : [] ) {
                    const delta = choice?.delta;
                    const thought = delta?.extra_content?.google?.thought === true;
                    if ( !delta ) continue;
                    if ( typeof delta.content === 'string' ) {
                        const content = delta.content.replace( /<\/?thought>/gi, '' );
                        if ( thought ) {
                            delta.reasoning = content;
                        } else {
                            delta.content = content;
                        }
                    }
                    if ( thought ) delete delta.extra_content;
                }
                return 'data: ' + JSON.stringify( payload ) + '\n';
            } catch { return line; }
        } ).join( '' );
    }

    private withGeminiThinking( body: any, selectedModel: string ): any {
        if ( !body || typeof body !== 'object' ) return body;
        const { reasoning_effort, reasoning, thinking, include_reasoning, output_reasoning, ...rest } = body;
        const effort = typeof reasoning_effort === 'string' ? reasoning_effort : typeof reasoning?.effort === 'string' ? reasoning.effort : undefined;
        if ( !effort ) return rest;
        const isGemini25 = /gemini-2\.5/i.test( selectedModel );
        if ( effort === 'none' && !isGemini25 ) throw new Error( 'reasoning_effort=none is only supported by Gemini 2.5 models' );
        const config = rest.extra_body?.google?.thinking_config || {};
        return { ...rest, extra_body: { ...( rest.extra_body || {} ), google: { ...( rest.extra_body?.google || {} ), thinking_config: { ...config, include_thoughts: true, ...( isGemini25 ? { thinking_budget: effort === 'none' ? 0 : ( { low: 1024, medium: 8192, high: 24576 } as Record<string, number> )[effort] ?? 8192 } : { thinking_level: effort === 'minimal' ? 'minimal' : effort } ) } } } };
    }
    private isGeminiProvider( config: OpenAIModelConfig ): boolean {
        return config.extra?.isGemini === true;
    }


    private getRoundRobinBackends( modelName: string, backends: OpenAIModelConfig[] ): OpenAIModelConfig[] {
        if ( backends.length <= 1 ) {
            return backends;
        }

        const key = `model:${modelName}`;
        const startIndex = this.getAndIncrementRoundRobinIndex( key, backends.length );
        return [
            ...backends.slice( startIndex ),
            ...backends.slice( 0, startIndex ),
        ];
    }

    private getOptimizedBackends( modelName: string, endpoint: string | undefined, backends: OpenAIModelConfig[] ): OpenAIModelConfig[] {
        if ( backends.length <= 1 ) {
            return backends;
        }

        // The eligible backend list is group-scoped and can differ for the same
        // model depending on the request's routing group. Include it in the key
        // so a previously cached mixed-group result can never leak into fallback.
        const eligibleBackendKey = backends.map( backend => backend.id ).sort().join( ',' );
        const cacheKey = `${endpoint ?? 'default'}:${modelName}:${eligibleBackendKey}`;
        const cached = this.optimizedBackendCache.get( cacheKey );
        if ( cached && cached.expiresAt > Date.now() ) {
            return cached.backends;
        }

        const rotated = this.getRoundRobinBackends( cacheKey, backends );
        const sorted = rotated.sort( ( left, right ) =>
            this.scoreProvider( right, modelName ) - this.scoreProvider( left, modelName )
        );

        // Group isolation: fallback must stay within the primary backend's
        // groupSpace. Without this, a failed gemini-group backend falls back
        // into the default group (and vice versa), breaking group isolation.
        const primaryBackend = sorted[0];
        const groupIsolatedSorted = primaryBackend
            ? sorted.filter( b => ( ( b as any ).groupSpace || 'default' ) === ( ( primaryBackend as any ).groupSpace || 'default' ) )
            : sorted;

        this.optimizedBackendCache.set( cacheKey, {
            backends: groupIsolatedSorted,
            expiresAt: Date.now() + OpenAIProxy.BACKEND_CACHE_TTL_MS,
        } );

        if ( this.optimizedBackendCache.size > OpenAIProxy.MAX_CACHE_SIZE ) {
            const firstKey = this.optimizedBackendCache.keys().next().value;
            if ( firstKey ) {
                this.optimizedBackendCache.delete( firstKey );
            }
        }

        return groupIsolatedSorted;
    }

    private scoreProvider( config: OpenAIModelConfig, requestedModel: string ): number {
        const candidateModels = this.getCandidateModelsForProvider( config, requestedModel );
        const firstModel = candidateModels[0] ?? requestedModel;
        const stats = this.providerStats.getStats( config.id, firstModel );
        const latencyScore = stats?.latencyEwmaMs ? Math.max( 0, 1 - stats.latencyEwmaMs / 30_000 ) : 0.5;
        const successScore = stats?.successRateEwma ?? 1;
        const exactScore = this.configHasModel( config, requestedModel ) ? 1 : 0;
        return exactScore * 100
            + successScore * 10
            + latencyScore
            + this.scoreModelSpeedHint( firstModel )
            - ( stats?.consecutiveFailures ?? 0 );
    }

    private getNextRoundRobinConfig( key: string, backends: OpenAIModelConfig[] ): OpenAIModelConfig | undefined {
        if ( !backends.length ) {
            return undefined;
        }

        const index = this.getAndIncrementRoundRobinIndex( key, backends.length );
        return backends[index];
    }

    private getAndIncrementRoundRobinIndex( key: string, total: number ): number {
        if ( total <= 0 ) {
            return 0;
        }

        // Clean up the rrIndexByKey map if it gets too large to prevent memory leak
        if ( this.rrIndexByKey.size > OpenAIProxy.MAX_CACHE_SIZE ) {
            // Remove a random entry
            const keys = Array.from( this.rrIndexByKey.keys() );
            const randomKey = keys[Math.floor( Math.random() * keys.length )];
            this.rrIndexByKey.delete( randomKey! );
        }

        const current = this.rrIndexByKey.get( key ) ?? 0;
        const index = current % total;
        this.rrIndexByKey.set( key, ( index + 1 ) % total );
        return index;
    }

    private buildHeaders( config: OpenAIModelConfig ): Record<string, string> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`,
            'User-Agent': 'ai-edge/1.0',
        };
        if ( CONFIG.spoofer === true ) {
            return applySpoofHeaders( headers );
        }
        return headers;
    }

    private getCandidateModelsForProvider( config: OpenAIModelConfig, requestedModel: string, includeSiblings = false ): string[] {
        const explicitlyAuto = this.isAutoModel( requestedModel );
        const requestedNormalized = stripFreeModifier( requestedModel ).normalizedId;
        const modelInThisProvider = config.models.some( m => {
            const candidate = typeof m === 'string' ? m : ( m as any ).model;
            return stripFreeModifier( candidate ).normalizedId === requestedNormalized;
        } );
        // Unlisted models treated as auto-edge: pick best model from provider.
        const isAutoModel = explicitlyAuto || !modelInThisProvider;

        if ( isAutoModel ) {
            const modelNames = config.models.map( m => ( typeof m === 'string' ? m : ( m as any ).model ) );
            const uniqueModels = Array.from( new Set( modelNames ) );
            return [...uniqueModels].sort( ( left, right ) =>
                this.scoreModelForProvider( config, right ) - this.scoreModelForProvider( config, left )
            );
        }

        // Explicit model request. Providers that do NOT participate in random
        // routing only ever serve the exact requested model.
        if ( config.randomRouting === false ) {
            return [requestedModel];
        }

        // Sibling pass (last resort): when the requested model is exhausted
        // across the whole group, participating providers offer their other
        // models as substitution — this is the return benefit for taking part
        // in random routing. Cap per provider to bound worst-case fan-out.
        if ( includeSiblings ) {
            const modelNames = config.models.map( m => ( typeof m === 'string' ? m : ( m as any ).model ) );
            const uniqueModels = Array.from( new Set( modelNames ) );
            return uniqueModels.filter( m => m !== requestedModel ).sort( ( left, right ) =>
                this.scoreModelForProvider( config, right ) - this.scoreModelForProvider( config, left )
            ).slice( 0, OpenAIProxy.MAX_SIBLING_MODELS_PER_PROVIDER );
        }

        return [requestedModel];
    }

    private scoreModelForProvider( config: OpenAIModelConfig, modelName: string ): number {
        const stats = this.providerStats.getStats( config.id, modelName );
        const latencyScore = stats?.latencyEwmaMs ? Math.max( 0, 1 - stats.latencyEwmaMs / 30_000 ) : 0.5;
        const successScore = stats?.successRateEwma ?? 1;
        return successScore * 10
            + latencyScore
            + this.scoreModelSpeedHint( modelName )
            - ( stats?.consecutiveFailures ?? 0 );
    }

    private scoreModelSpeedHint( modelName: string ): number {
        const normalized = stripFreeModifier( modelName ).normalizedId.toLowerCase();
        let score = 0;
        if ( normalized.includes( 'flash-lite' ) || normalized.includes( 'lite' ) ) {
            score += 2;
        } else if ( FAST_MODEL_HINTS.some( hint => normalized.includes( hint ) ) ) {
            score += 1;
        }
        if ( normalized.includes( 'preview' ) ) {
            score -= 0.25;
        }
        return score;
    }

    private withReasoningEffort( body: any, config: OpenAIModelConfig, selectedModel: string ): any {
        if ( !this.isReasoningConfiguredForModel( config, selectedModel ) ) {
            return this.stripReasoningFields( body );
        }

        if ( !this.hasExplicitReasoningRequest( body ) ) {
            return body;
        }

        const effort = this.resolveReasoningEffort( body, config, selectedModel );
        if ( !effort || effort === 'none' ) {
            return body;
        }

        return {
            ...body,
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

    private stripCompletionThoughtTags( payload: any ): any {
        if ( !payload || typeof payload !== 'object' ) return payload;
        for ( const choice of Array.isArray( payload.choices ) ? payload.choices : [] ) {
            const message = choice?.message;
            if ( message && typeof message === 'object' && typeof message.content === 'string' ) {
                const thoughts: string[] = [];
                message.content = message.content.replace( /<thought>([\s\S]*?)<\/thought>/gi, ( _match: string, thought: string ) => {
                    thoughts.push( thought );
                    return '';
                } ).replace( /<\/?thought>/gi, '' );
                if ( thoughts.length > 0 ) {
                    const extracted = thoughts.join( '\n' );
                    message.reasoning = typeof message.reasoning === 'string' && message.reasoning
                        ? `${message.reasoning}\n${extracted}`
                        : extracted;
                }
            }
            for ( const field of ['reasoning', 'reasoning_content', 'thinking'] ) {
                if ( typeof message?.[field] === 'string' ) message[field] = message[field].replace( /<\/?thought>/gi, '' );
                if ( typeof choice?.delta?.[field] === 'string' ) choice.delta[field] = choice.delta[field].replace( /<\/?thought>/gi, '' );
            }
            if ( typeof choice?.delta?.content === 'string' ) choice.delta.content = choice.delta.content.replace( /<\/?thought>/gi, '' );
            if ( typeof choice?.text === 'string' ) choice.text = choice.text.replace( /<\/?thought>/gi, '' );
        }
        return payload;
    }
    private async parseResponsePayload( response: Response ): Promise<any> {
        const contentType = response.headers.get( 'content-type' ) ?? '';

        if ( contentType.includes( 'application/json' ) ) {
            return response.json().then( payload => this.stripCompletionThoughtTags( payload ) ).catch( () => ( {
                error: {
                    message: 'Upstream returned invalid JSON',
                    type: 'upstream_error'
                }
            } ) );
        }

        const text = await response.text().catch( () => '' );
        if ( !text ) {
            return {
                error: {
                    message: response.statusText || 'Upstream request failed',
                    type: 'upstream_error'
                }
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

    /**
     * Send a Responses-format SSE error. Used when the upstream fails or model
     * is not found but Codex expects SSE events (stream: true, wire_api: responses).
     * Without this, Codex hangs waiting for `response.completed`.
     */
    private sendResponsesStreamError( modelName: string, errorMessage?: string ): Response {
        const encoder = new TextEncoder();
        const responseId = `resp_${Date.now().toString( 36 )}`;
        const created = Math.floor( Date.now() / 1000 );
        const events: string[] = [
            `event: response.created\ndata: ${JSON.stringify( {
                type: 'response.created',
                response: {
                    id: responseId,
                    object: 'response',
                    status: 'in_progress',
                    created,
                    model: modelName,
                    output: [],
                },
            } )}\n\n`,
            `event: response.in_progress\ndata: ${JSON.stringify( {
                type: 'response.in_progress',
                response: {
                    id: responseId,
                    status: 'in_progress',
                },
            } )}\n\n`,
        ];

        // If there's a real error from the upstream, emit an error event so
        // the client can surface it instead of silently showing empty output.
        if ( errorMessage ) {
            events.push( `event: error\ndata: ${JSON.stringify( {
                type: 'error',
                error: { type: 'upstream_error', message: errorMessage },
            } )}\n\n` );
        }

        events.push( `event: response.completed\ndata: ${JSON.stringify( {
            type: 'response.completed',
            response: {
                id: responseId,
                object: 'response',
                status: 'completed',
                created,
                model: modelName,
                output: [],
                usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
            },
        } )}\n\n` );

        emitResponsesDoneSentinel( events );
        const data = events.join( '' );
        const stream = new ReadableStream( {
            start( controller ) {
                controller.enqueue( encoder.encode( data ) );
                controller.close();
            },
        } );
        return new Response( stream, {
            status: 200,
            headers: {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
            },
        } );
    }

    private async streamResponsesConverted(
        c: Context,
        response: Response,
        originalResponsesBody: any,
        providerId: string,
        selectedModel: string,
        requestStartedAt: number,
        fileSearchCalls?: FileSearchCallItem[],
    ): Promise<Response> {
        const endpoint = 'responses';
        const encoder = new TextEncoder();
        const upstreamReader = response.body!.getReader();
        const decoder = new TextDecoder();
        const responsesState = createResponsesStreamState( originalResponsesBody, requestStartedAt );
        if ( fileSearchCalls && fileSearchCalls.length > 0 ) {
            responsesState.fileSearchCalls = fileSearchCalls;
        }
        let firstChunkLogged = false;
        let clientDisconnected = false;
        let sseBuffer = '';

        c.header( 'Content-Type', 'text/event-stream; charset=utf-8' );
        c.header( 'Transfer-Encoding', 'chunked' );
        c.header( 'Cache-Control', 'no-cache, no-transform' );
        c.header( 'Connection', 'keep-alive' );
        c.header( 'X-Accel-Buffering', 'no' );

        const clientSignal = c.req.raw.signal;
        const onClientAbort = () => {
            clientDisconnected = true;
            upstreamReader.cancel( 'client disconnected' ).catch( () => { } );
        };
        clientSignal.addEventListener( 'abort', onClientAbort, { once: true } );

        const stream = new ReadableStream( {
            start( controller ) {
                let completedEmitted = false;

                const processChunk = ( sseBuffer: string ): string => {
                    const out: string[] = [];
                    const parts = sseBuffer.split( '\n\n' );
                    const remainder = parts.pop() ?? '';

                    for ( const block of parts ) {
                        const dataLine = block.split( '\n' ).find( ( l ) => l.startsWith( 'data:' ) );
                        if ( !dataLine ) continue;

                        const data = dataLine.slice( 5 ).trimStart();
                        if ( !data || data === '[DONE]' ) {
                            processChatStreamChunkForResponses( null, responsesState, out );
                        } else {
                            try {
                                const chunk = JSON.parse( data );
                                processChatStreamChunkForResponses( chunk, responsesState, out );
                            } catch { /* ignore malformed chunks */ }
                        }
                    }

                    if ( out.length ) controller.enqueue( encoder.encode( out.join( '' ) ) );
                    return remainder;
                };

                /** Emit response.completed exactly once, guaranteed. */
                const emitCompleted = () => {
                    if ( completedEmitted ) return;
                    completedEmitted = true;

                    try {
                        if ( !responsesState.finished ) {
                            const out: string[] = [];
                            processChatStreamChunkForResponses( null, responsesState, out );
                            if ( out.length ) controller.enqueue( encoder.encode( out.join( '' ) ) );
                        }
                    } catch { /* best-effort */ }

                    try {
                        const completedOut: string[] = [];
                        emitResponsesCompleted( responsesState, completedOut );
                        emitResponsesDoneSentinel( completedOut );
                        if ( completedOut.length ) {
                            controller.enqueue( encoder.encode( completedOut.join( '' ) ) );
                        } else {
                            console.warn( `[${endpoint}] emitResponsesCompleted produced no events for provider=${providerId} model=${selectedModel}` );
                        }
                        console.info( `[${endpoint}] response_completed_emitted provider=${providerId} model=${selectedModel} clientDisconnected=${clientDisconnected} responseId=${responsesState.responseId}` );
                    } catch ( completedErr: any ) {
                        console.error( `[${endpoint}] Failed to emit response.completed: ${completedErr?.message || String( completedErr )}` );
                        // Last resort: emit a minimal response.completed so the client gets *something*
                        try {
                            const fallback = [
                                `event: response.completed\ndata: ${JSON.stringify( {
                                    type: 'response.completed',
                                    response: {
                                        id: responsesState.responseId,
                                        object: 'response',
                                        status: 'completed',
                                        created: responsesState.created,
                                        model: responsesState.model,
                                        output: [],
                                        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
                                    },
                                } )}\n\n`,
                                'data: [DONE]\n\n',
                            ].join( '' );
                            controller.enqueue( encoder.encode( fallback ) );
                        } catch { /* truly nothing we can do */ }
                    }
                };

                ( async () => {
                    try {
                        while ( !clientDisconnected ) {
                            const { done, value } = await upstreamReader.read();
                            if ( done ) break;
                            if ( value && !firstChunkLogged ) {
                                firstChunkLogged = true;
                                console.info( `[${endpoint}] stream_first_chunk provider=${providerId} model=${selectedModel} firstByteMs=${Date.now() - requestStartedAt}` );
                            }
                            if ( value ) {
                                sseBuffer += decoder.decode( value, { stream: true } );
                            }

                            sseBuffer = processChunk( sseBuffer );

                            // NOTE: Do NOT break when responsesState.finished becomes true here.
                            // OpenAI's streaming protocol sends the `usage` chunk (with token
                            // counts) as a SEPARATE SSE message AFTER the `finish_reason` chunk.
                            // Breaking early would skip that usage chunk, resulting in zero token
                            // counts in the response.completed event.  Instead, keep reading
                            // until the upstream closes the connection (`done === true`).
                            // The processChatStreamChunkForResponses function is idempotent on
                            // finishResponsesStream, so extra chunks after finish are safe.
                        }

                        // Flush remaining buffer
                        if ( sseBuffer.trim() && !clientDisconnected ) {
                            processChunk( sseBuffer + '\n\n' );
                        }
                    } catch ( err: any ) {
                        console.error( `[${endpoint}] Streaming error: ${err?.message || String( err )} provider=${providerId} model=${selectedModel}` );
                        // Finish the stream state so the completed event below has the right status
                        const out: string[] = [];
                        processChatStreamChunkForResponses( null, responsesState, out );
                        try {
                            controller.enqueue( encoder.encode( [
                                ...out,
                                `event: error\ndata: ${JSON.stringify( {
                                    type: 'error',
                                    error: { type: 'upstream_error', message: err?.message || 'An error occurred during streaming' },
                                } )}\n\n`,
                            ].join( '' ) ) );
                        } catch { /* stream may already be errored */ }
                    }

                    // ── GUARANTEED: emit response.completed before closing ──
                    // This MUST run even on error. The Codex client disconnects
                    // if it never receives this event, causing the "stream closed
                    // before response.completed" error.
                    emitCompleted();

                    if ( !clientDisconnected ) {
                        console.info( `[${endpoint}] stream_complete provider=${providerId} model=${selectedModel} totalMs=${Date.now() - requestStartedAt}` );
                    }
                } )().finally( () => {
                    clientSignal.removeEventListener( 'abort', onClientAbort );
                    try { upstreamReader.releaseLock(); } catch { /* ignore */ }
                    try { controller.close(); } catch { /* stream may already be closed */ }
                } );
            },
        } );

        return new Response( stream, {
            status: 200,
            headers: {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
            },
        } );
    }

    private buildApiUrl( config: OpenAIModelConfig, endpoint: string ): string {
        const baseUrl = this.normalizeBaseUrl( config.baseUrl );
        return `${baseUrl}/${endpoint}`;
    }

    private normalizeBaseUrl( baseUrl: string ): string {
        return baseUrl.replace( /\/+$/, '' );
    }

    private calculateTokenCount( body: any ): number {
        if ( body?.input !== undefined ) {
            const embeddingTokens = this.calculateEmbeddingTokenCount( body.input );
            if ( embeddingTokens > 0 ) {
                return embeddingTokens;
            }
        }

        return this.calculateTokenCountFromStrings( this.extractRequestTokenStrings( body ) );
    }

    private attachUsageIfMissing( endpoint: string, requestBody: any, responseData: any ): any {
        if ( !responseData || typeof responseData !== 'object' || Array.isArray( responseData ) ) {
            return responseData;
        }

        if ( responseData.usage ) {
            return responseData;
        }

        const usage = this.buildUsageForEndpoint( endpoint, requestBody, responseData );
        if ( !usage ) {
            return responseData;
        }

        return {
            ...responseData,
            usage,
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

    private buildUsageForEndpoint( endpoint: string, requestBody: any, responseData: any ): Record<string, any> | null {
        const promptTokens = this.calculateTokenCountFromStrings( this.extractRequestTokenStrings( requestBody, endpoint ), 0 );
        const completionTokens = this.calculateTokenCountFromStrings( this.extractResponseTokenStrings( endpoint, responseData ), 0 );

        if ( endpoint === 'responses' ) {
            return {
                input_tokens: promptTokens,
                input_tokens_details: {
                    cached_tokens: 0,
                },
                output_tokens: completionTokens,
                output_tokens_details: {
                    reasoning_tokens: responseData?.usage?.completion_tokens_details?.reasoning_tokens ?? 0,
                },
                total_tokens: promptTokens + completionTokens,
            };
        }

        if ( endpoint === 'embeddings' ) {
            const embeddingTokens = this.calculateEmbeddingTokenCount( requestBody?.input );
            return {
                prompt_tokens: embeddingTokens || promptTokens,
                total_tokens: embeddingTokens || promptTokens,
            };
        }

        if ( endpoint === 'chat/completions' || endpoint === 'completions' ) {
            return {
                prompt_tokens: promptTokens,
                completion_tokens: completionTokens,
                total_tokens: promptTokens + completionTokens,
            };
        }

        // Images endpoints use token usage from the response if available
        if ( endpoint === 'images/generations' || endpoint === 'images/edits' ) {
            return null;
        }

        return null;
    }

    private extractRequestTokenStrings( body: any, endpoint?: string ): string[] {
        if ( !body ) {
            return [];
        }

        if ( endpoint === 'completions' ) {
            return this.collectTokenStrings( body.prompt );
        }

        if ( endpoint === 'chat/completions' ) {
            return this.collectTokenStrings( body.messages );
        }

        if ( endpoint === 'responses' ) {
            return [
                ...this.collectTokenStrings( body.input ),
                ...this.collectTokenStrings( body.instructions ),
                ...this.collectTokenStrings( body.prompt ),
            ];
        }

        if ( endpoint === 'embeddings' ) {
            return this.collectTokenStrings( body.input );
        }

        if ( endpoint === 'images/generations' || endpoint === 'images/edits' ) {
            return this.collectTokenStrings( body.prompt );
        }

        return this.collectTokenStrings( body );
    }

    private extractResponseTokenStrings( endpoint: string, responseData: any ): string[] {
        if ( !responseData || typeof responseData !== 'object' ) {
            return [];
        }

        if ( endpoint === 'completions' || endpoint === 'chat/completions' ) {
            return this.collectTokenStrings( responseData.choices );
        }

        if ( endpoint === 'responses' ) {
            return this.collectTokenStrings( responseData.output );
        }

        if ( endpoint === 'embeddings' ) {
            return [];
        }

        if ( endpoint === 'images/generations' || endpoint === 'images/edits' ) {
            return [];
        }

        return this.collectTokenStrings( responseData );
    }

    private collectTokenStrings( value: any ): string[] {
        if ( value == null ) {
            return [];
        }

        if ( typeof value === 'string' ) {
            return [value];
        }

        if ( typeof value === 'number' || typeof value === 'boolean' ) {
            return [];
        }

        if ( Array.isArray( value ) ) {
            return value.flatMap<string>( item => this.collectTokenStrings( item ) );
        }

        if ( typeof value !== 'object' ) {
            return [];
        }

        const countableKeys = new Set( [
            'content',
            'text',
            'input',
            'prompt',
            'instructions',
            'messages',
            'message',
            'choices',
            'output',
            'tool_calls',
            'function_call',
            'arguments',
            'code',
            'logs',
            'refusal',
            'query',
            'queries',
            'variables',
            'delta',
            'file_data',
            'file_url',
            'image_url',
        ] );

        const ignoredKeys = new Set( [
            'annotations',
            'metadata',
            'usage',
            'error',
            'id',
            'role',
            'status',
            'type',
            'object',
            'model',
            'created',
            'created_at',
            'finish_reason',
            'index',
            'system_fingerprint',
            'incomplete_details',
            'reason',
        ] );

        return Object.entries( value ).flatMap<string>( ( [key, nestedValue] ) => {
            if ( ignoredKeys.has( key ) ) {
                return [];
            }

            if ( countableKeys.has( key ) ) {
                return this.collectTokenStrings( nestedValue );
            }

            return [];
        } );
    }

    private calculateTokenCountFromStrings( values: string[], fallback: number = 100 ): number {
        const total = values.reduce( ( sum: number, value: string ) =>
            sum + Math.max( 1, Math.ceil( value.length / 4 ) ), 0
        );

        return total || fallback;
    }

    private calculateEmbeddingTokenCount( input: any ): number {
        if ( input == null ) {
            return 0;
        }

        if ( typeof input === 'string' ) {
            return Math.max( 1, Math.ceil( input.length / 4 ) );
        }

        if ( typeof input === 'number' ) {
            return 1;
        }

        if ( Array.isArray( input ) ) {
            if ( input.length === 0 ) {
                return 0;
            }

            if ( input.every( item => typeof item === 'number' ) ) {
                return input.length;
            }

            return input.reduce( ( sum: number, item: any ) => sum + this.calculateEmbeddingTokenCount( item ), 0 );
        }

        if ( typeof input === 'object' ) {
            return this.collectTokenStrings( input ).reduce( ( sum: number, value: string ) =>
                sum + Math.max( 1, Math.ceil( value.length / 4 ) ), 0
            );
        }

        return 0;
    }

    /**
     * Process an upstream request with full provider fallback logic.
     * Returns a structured result for callers that manage their own response
     * transport (e.g. WebSocket).
     */
    public async processUpstreamWithFallback( body: any, endpoint: string, options: {
        responseId: string;
        model: string;
        stream?: boolean;
        targetGroup?: string;
    } ): Promise<{ status: number; payload?: any; response?: Response; providerId?: string; selectedModel?: string }> {
        const requestStartedAt = Date.now();
        const modelName = options.model;

        if ( !modelName || typeof modelName !== 'string' ) {
            return {
                status: 400,
                payload: { error: { message: 'Model is required and must be a string', type: 'invalid_request_error' } },
            };
        }

        const matchingBackends = this.getBackendsForModel( modelName, endpoint, options.targetGroup );
        if ( !matchingBackends.length ) {
            console.error( `[ws:${endpoint}] No backends found for model: ${modelName}` );
            return {
                status: 400,
                payload: { error: { message: `Model not found: ${modelName}`, type: 'invalid_request_error' } },
            };
        }

        const backends = this.getOptimizedBackends( modelName, endpoint, matchingBackends );
        console.error( `[ws:${endpoint}] Attempting backends for model ${modelName}: ${backends.map( b => b.id ).join( ', ' )}` );

        // Two-pass attempt plan (see proxyRequest): exact model first, then
        // sibling models from random-routing participants in the same group.
        const attempts: { config: OpenAIModelConfig; selectedModel: string }[] = [];
        for ( const config of backends ) {
            const candidateModels = this.getCandidateModelsForProvider( config, modelName );
            for ( const selectedModel of candidateModels ) {
                attempts.push( { config, selectedModel } );
            }
        }
        const isAutoEdgeRequest = this.isAutoModel( modelName )
            || !( CONFIG.models.openai ?? [] ).some( c => this.configHasModel( c, modelName ) );
        let attemptIdx = 0;
        let siblingPassAppended = false;

        while ( true ) {
            if ( attemptIdx >= attempts.length ) {
                if ( !siblingPassAppended && !isAutoEdgeRequest ) {
                    siblingPassAppended = true;
                    console.error( `[ws:${endpoint}] In-group backends exhausted for ${modelName} — sibling pass (random-routing participants)` );
                    for ( const config of backends ) {
                        const siblings = this.getCandidateModelsForProvider( config, modelName, true );
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
                    continue;
                }

                const requestWithModel = { ...body, model: selectedModel };
                const withReasoning = this.withReasoningEffort( requestWithModel, config, selectedModel );
                const upstreamBodyRaw = this.isGeminiProvider( config )
                    ? this.ensureToolCallThoughtSignatures( this.withGeminiThinking( withReasoning, selectedModel ) )
                    : withReasoning;
                const upstreamBody = isStringContentOnlyProvider( config )
                    ? normalizeMessagesContentToString( upstreamBodyRaw )
                    : upstreamBodyRaw;

                const tokens = this.calculateTokenCount( upstreamBody );
                const rateLimit = this.getEffectiveRateLimit( config, selectedModel );
                // ── Preemptive TPM-meter hop (see proxyRequest) ──
                if ( this.isGeminiProvider( config ) && rateLimit ) {
                    const meterRemaining = await rateLimitManager.peekRemaining( config.id, rateLimit, selectedModel );
                    if ( meterRemaining !== null && meterRemaining < tokens ) {
                        console.error( `[ws:${endpoint}] TPM meter low provider=${config.id} model=${selectedModel} remaining=${meterRemaining} need=${tokens} — preemptive hop` );
                        continue;
                    }
                }
                const rateCheck = await rateLimitManager.checkAndConsume( config.id, tokens, rateLimit, selectedModel );
                if ( !rateCheck.allowed ) {
                    continue;
                }

                try {
                    const url = this.buildApiUrl( config, endpoint );
                    const upstreamResponse = await fetchWithProxy( url, {
                        method: 'POST',
                        headers: this.buildHeaders( config ),
                        body: JSON.stringify( upstreamBody ),
                    }, CONFIG.proxy, { skipTimeout: upstreamBody.stream === true } );

                    backendCooldownManager.markFromStatus( config.id, selectedModel, upstreamResponse.status );
                    if ( upstreamResponse.status === 429 ) {
                        this.providerStats.recordFailure( config.id, selectedModel );
                        console.warn( `[ws:${endpoint}] 429 from ${config.id}, trying next backend` );
                        continue;
                    }

                    if ( this.isRedirectStatus( upstreamResponse.status ) ) {
                        const location = upstreamResponse.headers.get( 'location' );
                        if ( location ) {
                            const redirectModel = this.extractModelFromLocation( location );
                            if ( redirectModel && redirectModel !== modelName ) {
                                return this.processUpstreamWithFallback(
                                    { ...body, model: redirectModel }, endpoint, { ...options, model: redirectModel },
                                );
                            }
                        }
                    }

                    // Non-2xx (401, 403, 500, etc.) — skip to next backend
                    if ( !upstreamResponse.ok ) {
                        this.providerStats.recordFailure( config.id, selectedModel );
                        console.error( `[ws:${endpoint}] ${upstreamResponse.status} from ${config.id} — trying next backend` );
                        continue;
                    }

                    this.providerStats.recordSuccess( config.id, selectedModel );
                    return {
                        status: upstreamResponse.status,
                        response: upstreamResponse,
                        providerId: config.id,
                        selectedModel,
                    };
                } catch ( error: any ) {
                    this.providerStats.recordFailure( config.id, selectedModel );
                    console.error( `[ws:${endpoint}] Exception from ${config?.id}: ${error?.message || String( error )}` );
                    continue;
                }
            }

        console.error( `[ws:${endpoint}] ALL PROVIDERS FAILED for model ${modelName}` );
        return {
            status: 502,
            payload: { error: { message: 'All providers failed', type: 'internal_error' } },
        };
    }
}

export const openAIProxy = new OpenAIProxy();








