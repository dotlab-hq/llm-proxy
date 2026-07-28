import type { Context } from 'hono';
import { backendCooldownManager } from '../../BackendCooldownManager';
import { rateLimitManager } from '../../RateLimitManager';
import { CONFIG } from '@/utils/schema.lookup';
import { fetchWithProxy } from '@/utils/proxyFetch';
import { stripFreeModifier } from '@/utils/modelIds';
import {
    getBackendsForModel,
    getOptimizedBackends,
    getCandidateModelsForProvider,
    isTtsEnabled,
} from '../routing';
import {
    buildApiUrl,
    parseResponsePayload,
} from '../helpers';
import type { BackendState, OpenAIModelConfig } from '../types';

export async function handleAudioSpeech( c: Context, state: BackendState ) {
    const endpoint = 'audio/speech';
    const requestStartedAt = Date.now();
    let lastFailure: { status: number; payload: any } | null = null;

    try {
        const body = await c.req.json().catch( () => ( {} ) );
        const model = body?.model as string | undefined;
        const input = body?.input as string | undefined;
        const voice = body?.voice as string | undefined;

        if ( !model ) return c.json( { error: { message: 'model is required', type: 'invalid_request_error' } }, 400 );
        if ( !input || typeof input !== 'string' ) return c.json( { error: { message: 'input is required', type: 'invalid_request_error' } }, 400 );
        if ( !voice ) return c.json( { error: { message: 'voice is required', type: 'invalid_request_error' } }, 400 );

        const characters = input.length;
        const wantsStream = body?.stream === true || body?.stream_format != null;

        const matchingBackends = getBackendsForModel( state, model, endpoint );
        if ( !matchingBackends.length ) {
            console.error( `[${endpoint}] No TTS backends found for model: ${model}` );
            return c.json( { error: { message: `Model not found: ${model}`, type: 'invalid_request_error' } }, 400 );
        }

        const backends = getOptimizedBackends( state, model, endpoint, matchingBackends );
        console.error( `[${endpoint}] Attempting backends for model ${model}: ${backends.map( b => b.id ).join( ', ' )}` );

        for ( const config of backends ) {
            const candidateModels = getCandidateModelsForProvider( state, config, model );

            for ( const selectedModel of candidateModels ) {
                const cooldownRemainingMs = backendCooldownManager.getRemainingMs( config.id, selectedModel );
                if ( cooldownRemainingMs > 0 ) {
                    console.warn( `[${endpoint}] cooldown_active provider=${config.id} model=${selectedModel} remainingMs=${cooldownRemainingMs}` );
                    continue;
                }

                const ttsRateLimit = getEffectiveTTSRateLimit( config, selectedModel );
                const charRateCheck = await rateLimitManager.checkAndConsumeTTSCharacters( config.id, characters, ttsRateLimit, selectedModel );
                if ( !charRateCheck.allowed ) {
                    console.error( `[${endpoint}] TTS rate limit exceeded for ${config.id}: ${charRateCheck.reason}` );
                    continue;
                }

                try {
                    const url = buildApiUrl( config, endpoint );
                    const mappedVoice = mapTTSVoice( voice, selectedModel );
                    const upstreamBody: Record<string, any> = { model: selectedModel, input, voice: mappedVoice };
                    if ( body?.instructions ) upstreamBody.instructions = body.instructions;
                    const upstreamFormat = getUpstreamResponseFormat( config, body?.response_format );
                    if ( upstreamFormat ) upstreamBody.response_format = upstreamFormat;
                    if ( body?.speed != null ) upstreamBody.speed = body.speed;
                    if ( wantsStream && body?.stream_format ) upstreamBody.stream_format = body.stream_format;

                    console.info( `[${endpoint}] upstream_request provider=${config.id} model=${selectedModel} voice=${mappedVoice} characters=${characters} stream=${wantsStream}` );

                    const upstreamResponse = await fetchWithProxy( url, {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', 'User-Agent': 'ai-edge/1.0' },
                        body: JSON.stringify( upstreamBody ),
                    }, CONFIG.proxy, { skipTimeout: wantsStream } );

                    backendCooldownManager.markFromStatus( config.id, selectedModel, upstreamResponse.status );

                    if ( upstreamResponse.status === 429 ) {
                        state.providerStats.recordFailure( config.id, selectedModel, Date.now() - requestStartedAt );
                        console.warn( `[${endpoint}] 429 from ${config.id}, trying next backend` );
                        continue;
                    }

                    if ( !upstreamResponse.ok ) {
                        lastFailure = { status: upstreamResponse.status, payload: await parseResponsePayload( upstreamResponse ) };
                        state.providerStats.recordFailure( config.id, selectedModel, Date.now() - requestStartedAt );
                        console.error( `[${endpoint}] ${upstreamResponse.status} from ${config?.id ?? config?.name}` );
                        continue;
                    }

                    const upstreamContentType = upstreamResponse.headers.get( 'content-type' ) || 'application/octet-stream';

                    if ( wantsStream && upstreamContentType.includes( 'text/event-stream' ) ) {
                        console.info( `[${endpoint}] stream_start provider=${config.id} model=${selectedModel} characters=${characters}` );
                        state.providerStats.recordSuccess( config.id, selectedModel, Date.now() - requestStartedAt );
                        backendCooldownManager.recordSuccess( config.id );
                        return proxyAudioStreamSSE( c, upstreamResponse, endpoint, config.id, selectedModel );
                    }

                    if ( wantsStream && upstreamResponse.body ) {
                        console.info( `[${endpoint}] audio_stream provider=${config.id} model=${selectedModel} characters=${characters}` );
                        state.providerStats.recordSuccess( config.id, selectedModel, Date.now() - requestStartedAt );
                        backendCooldownManager.recordSuccess( config.id );
                        return streamRawAudio( c, upstreamResponse, upstreamBody.response_format || body?.response_format || 'mp3' );
                    }

                    const responseBuffer = await upstreamResponse.arrayBuffer();
                    const effectiveFormat = upstreamBody.response_format || body?.response_format || 'mp3';
                    const mimeMap: Record<string, string> = { mp3: 'audio/mpeg', opus: 'audio/opus', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', pcm: 'audio/pcm' };
                    const contentType = mimeMap[effectiveFormat] || 'audio/mpeg';

                    console.info( `[${endpoint}] success provider=${config.id} model=${selectedModel} characters=${characters} totalMs=${Date.now() - requestStartedAt}` );
                    state.providerStats.recordSuccess( config.id, selectedModel, Date.now() - requestStartedAt );
                    backendCooldownManager.recordSuccess( config.id );
                    c.header( 'Content-Type', contentType );
                    return c.body( responseBuffer );
                } catch ( error: any ) {
                    state.providerStats.recordFailure( config.id, selectedModel );
                    console.error( `[${endpoint}] error provider=${config.id} model=${selectedModel}: ${error?.message}` );
                }
            }
        }

        if ( lastFailure ) return c.json( lastFailure.payload, lastFailure.status as any );
        return c.json( { error: { message: 'All TTS backends failed', type: 'server_error' } }, 502 );
    } catch ( error: any ) {
        console.error( `[${endpoint}] request_error: ${error?.message}` );
        return c.json( { error: { message: error?.message || 'Internal error', type: 'server_error' } }, 500 );
    }
}

function mapTTSVoice( voice: string, model: string ): string {
    const orpheusVoices = new Set( ['autumn', 'diana', 'hannah', 'austin', 'daniel', 'troy'] );
    const arabicVoices = new Set( ['abdullah', 'fahad', 'sultan', 'lulwa', 'noura', 'aisha'] );
    const lower = voice.toLowerCase();

    if ( model.includes( 'arabic' ) ) {
        if ( arabicVoices.has( lower ) ) return lower;
        return 'abdullah';
    }
    if ( orpheusVoices.has( lower ) ) return lower;

    const openaiToOrpheus: Record<string, string> = { alloy: 'troy', echo: 'daniel', fable: 'hannah', onyx: 'austin', nova: 'diana', shimmer: 'autumn' };
    return openaiToOrpheus[lower] ?? 'troy';
}

function getUpstreamResponseFormat( config: OpenAIModelConfig, requestedFormat?: string ): string | undefined {
    if ( !requestedFormat ) return undefined;
    const fmt = requestedFormat.toLowerCase();
    if ( config.baseUrl.includes( 'groq.com' ) && fmt !== 'wav' ) return 'wav';
    return requestedFormat;
}

function getEffectiveTTSRateLimit( config: OpenAIModelConfig, modelName?: string ): any {
    if ( modelName && config.individualLimit ) {
        const modelEntry = config.models.find( m => {
            const candidate = typeof m === 'string' ? m : ( m as any ).model;
            return stripFreeModifier( candidate ).normalizedId === stripFreeModifier( modelName ).normalizedId;
        } );
        if ( modelEntry && typeof modelEntry === 'object' && ( modelEntry as any ).rateLimit ) return ( modelEntry as any ).rateLimit;
    }
    return config.rateLimit;
}

function proxyAudioStreamSSE( c: Context, upstreamResponse: Response, endpoint: string, providerId: string, selectedModel: string ): Response {
    const encoder = new TextEncoder();
    const upstreamReader = upstreamResponse.body!.getReader();
    let clientDisconnected = false;
    c.header( 'Content-Type', 'text/event-stream; charset=utf-8' );
    c.header( 'Cache-Control', 'no-cache, no-transform' );
    c.header( 'Connection', 'keep-alive' );
    c.header( 'X-Accel-Buffering', 'no' );
    const clientSignal = c.req.raw.signal;
    const onClientAbort = () => { clientDisconnected = true; upstreamReader.cancel( 'client disconnected' ).catch( () => { } ); };
    clientSignal.addEventListener( 'abort', onClientAbort, { once: true } );
    const stream = new ReadableStream( {
        start( controller ) {
            ( async () => {
                try {
                    while ( !clientDisconnected ) {
                        const { done, value } = await upstreamReader.read();
                        if ( done ) break;
                        if ( value ) controller.enqueue( value );
                    }
                    console.info( `[${endpoint}] stream_complete provider=${providerId} model=${selectedModel}` );
                } catch ( err: any ) {
                    console.error( `[${endpoint}] stream_error provider=${providerId} model=${selectedModel}: ${err?.message || String( err )}` );
                    try { controller.enqueue( encoder.encode( `event: error\ndata: ${JSON.stringify( { type: 'error', error: { type: 'upstream_error', message: err?.message || 'Stream error' } } )}\n\n` ) ); } catch { /* ignore */ }
                }
            } )().finally( () => {
                clientSignal.removeEventListener( 'abort', onClientAbort );
                try { upstreamReader.releaseLock(); } catch { /* ignore */ }
                try { controller.close(); } catch { /* ignore */ }
            } );
        },
    } );
    return new Response( stream, { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' } } );
}

function streamRawAudio( c: Context, upstreamResponse: Response, responseFormat: string ): Response {
    const mimeMap: Record<string, string> = { mp3: 'audio/mpeg', opus: 'audio/opus', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', pcm: 'audio/pcm' };
    const contentType = mimeMap[responseFormat] || 'audio/mpeg';
    const upstreamReader = upstreamResponse.body!.getReader();
    let clientDisconnected = false;
    const clientSignal = c.req.raw.signal;
    const onClientAbort = () => { clientDisconnected = true; upstreamReader.cancel( 'client disconnected' ).catch( () => { } ); };
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
                    if ( !clientDisconnected ) console.error( `[audio/speech] stream_error provider=${configIdFrom( upstreamResponse )}: ${err?.message}` );
                } finally {
                    clientSignal.removeEventListener( 'abort', onClientAbort );
                    try { upstreamReader.releaseLock(); } catch { /* ignore */ }
                    try { controller.close(); } catch { /* already closed */ }
                }
            } )();
        },
    } );
    return new Response( audioStream, { status: 200, headers: { 'Content-Type': contentType, 'Transfer-Encoding': 'chunked', 'Cache-Control': 'no-cache' } } );
}

function configIdFrom( _r: Response ): string { return 'unknown'; }
