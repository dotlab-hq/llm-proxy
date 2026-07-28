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
    isSttEnabled,
} from '../routing';
import {
    buildApiUrl,
    parseResponsePayload,
    sendFailurePayload,
} from '../helpers';
import type { BackendState, OpenAIModelConfig } from '../types';

export async function handleAudioTranscriptions( c: Context, state: BackendState ) {
    return handleAudioRequest( c, state, 'audio/transcriptions' );
}

export async function handleAudioTranslations( c: Context, state: BackendState ) {
    return handleAudioRequest( c, state, 'audio/translations' );
}

async function handleAudioRequest( c: Context, state: BackendState, endpoint: string ): Promise<any> {
    const requestStartedAt = Date.now();
    let lastFailure: { status: number; payload: any } | null = null;

    try {
        const formData = await c.req.formData();
        const model = formData.get( 'model' ) as string | null;
        const file = formData.get( 'file' ) as File | null;

        if ( !model ) return c.json( { error: { message: 'model is required', type: 'invalid_request_error' } }, 400 );
        if ( !file ) return c.json( { error: { message: 'file is required', type: 'invalid_request_error' } }, 400 );

        const audioSeconds = estimateAudioDuration( file );

        const matchingBackends = getBackendsForModel( state, model, endpoint );
        if ( !matchingBackends.length ) {
            console.error( `[${endpoint}] No STT backends found for model: ${model}` );
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

                const sttRateLimit = getEffectiveSTTRateLimit( config, selectedModel );
                const audioRateCheck = await rateLimitManager.checkAndConsumeAudioSeconds( config.id, audioSeconds, sttRateLimit, selectedModel );
                if ( !audioRateCheck.allowed ) {
                    console.error( `[${endpoint}] STT rate limit exceeded for ${config.id}: ${audioRateCheck.reason}` );
                    continue;
                }

                try {
                    const url = buildApiUrl( config, endpoint );
                    const streamField = formData.get( 'stream' );
                    const wantsStream = streamField === 'true' || streamField === '1';

                    const boundary = `----AIEDGE${Math.random().toString( 36 ).slice( 2 )}`;
                    const parts: ( string | Buffer )[] = [];

                    function appendText( name: string, value: string ) {
                        parts.push( `--${boundary}\r\n`, `Content-Disposition: form-data; name="${name}"\r\n\r\n`, `${value}\r\n` );
                    }

                    appendText( 'model', selectedModel );

                    const fileBuffer = Buffer.from( await file.arrayBuffer() );
                    const fileName = file.name || 'audio.wav';
                    const fileType = file.type || 'audio/wav';
                    parts.push( `--${boundary}\r\n`, `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`, `Content-Type: ${fileType}\r\n\r\n`, fileBuffer, `\r\n` );

                    const textFields = ['language', 'prompt', 'response_format', 'temperature'] as const;
                    for ( const field of textFields ) {
                        const val = formData.get( field );
                        if ( val ) appendText( field, val as string );
                    }

                    for ( const tg of formData.getAll( 'timestamp_granularities[]' ) ) appendText( 'timestamp_granularities[]', tg as string );
                    if ( wantsStream ) appendText( 'stream', 'true' );
                    for ( const inc of formData.getAll( 'include[]' ) ) appendText( 'include[]', inc as string );
                    const chunkingStrategy = formData.get( 'chunking_strategy' );
                    if ( chunkingStrategy ) appendText( 'chunking_strategy', chunkingStrategy as string );
                    for ( const name of formData.getAll( 'known_speaker_names[]' ) ) appendText( 'known_speaker_names[]', name as string );
                    for ( const ref of formData.getAll( 'known_speaker_references[]' ) ) appendText( 'known_speaker_references[]', ref as string );

                    parts.push( `--${boundary}--\r\n` );
                    const upstreamBody = Buffer.concat( parts.map( p => typeof p === 'string' ? Buffer.from( p ) : p ) );

                    console.info( `[${endpoint}] upstream_request provider=${config.id} model=${selectedModel} audioSeconds=${audioSeconds} stream=${wantsStream}` );

                    const upstreamResponse = await fetchWithProxy( url, {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${config.apiKey}`, 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'User-Agent': 'ai-edge/1.0' },
                        body: upstreamBody,
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

                    const upstreamContentType = upstreamResponse.headers.get( 'content-type' ) || 'application/json';
                    if ( wantsStream && upstreamContentType.includes( 'text/event-stream' ) ) {
                        console.info( `[${endpoint}] stream_start provider=${config.id} model=${selectedModel} audioSeconds=${audioSeconds}` );
                        state.providerStats.recordSuccess( config.id, selectedModel, Date.now() - requestStartedAt );
                        backendCooldownManager.recordSuccess( config.id );
                        return proxyAudioStream( c, upstreamResponse, endpoint, config.id, selectedModel );
                    }

                    const responseText = await upstreamResponse.text();
                    console.info( `[${endpoint}] success provider=${config.id} model=${selectedModel} audioSeconds=${audioSeconds} totalMs=${Date.now() - requestStartedAt}` );
                    state.providerStats.recordSuccess( config.id, selectedModel, Date.now() - requestStartedAt );
                    backendCooldownManager.recordSuccess( config.id );

                    if ( upstreamContentType.includes( 'text/plain' ) || upstreamContentType.includes( 'text/vtt' ) || upstreamContentType.includes( 'application/x-subrip' ) ) {
                        c.header( 'Content-Type', upstreamContentType );
                        return c.text( responseText );
                    }

                    try {
                        return c.json( JSON.parse( responseText ) );
                    } catch {
                        c.header( 'Content-Type', upstreamContentType );
                        return c.body( responseText );
                    }
                } catch ( error: any ) {
                    state.providerStats.recordFailure( config.id, selectedModel );
                    lastFailure = { status: 502, payload: { error: { message: error?.message || 'Upstream request failed', type: 'upstream_error' } } };
                    console.error( `[${endpoint}] Exception from ${config?.id ?? config?.name}: ${error?.message || String( error )}` );
                    continue;
                }
            }
        }

        if ( lastFailure ) {
            const errorPayload = typeof lastFailure.payload === 'object' ? JSON.stringify( lastFailure.payload ) : String( lastFailure.payload );
            console.error( `\n❌ [${endpoint}] FINAL FAILURE (${lastFailure.status})\nAttempted backends: ${backends.map( b => b.id ).join( ', ' )}\nError: ${errorPayload}\n` );
            return sendFailurePayload( c, lastFailure.status, lastFailure.payload );
        }

        console.error( `\n❌ [${endpoint}] ALL PROVIDERS FAILED\nModel: ${model}\nAttempted: ${backends.map( b => b.id ).join( ', ' )}\n` );
        return c.json( { error: { message: 'All providers failed', type: 'internal_error' } }, 502 );
    } catch ( error: any ) {
        console.error( `[${endpoint}] Exception:`, error?.message || String( error ) );
        return c.json( { error: { message: error?.message || 'Internal error', type: 'internal_error' } }, 500 );
    }
}

function estimateAudioDuration( file: File ): number {
    const name = file.name.toLowerCase();
    const sizeBytes = file.size;

    if ( name.endsWith( '.wav' ) || name.endsWith( '.wave' ) ) {
        return Math.max( 1, Math.ceil( sizeBytes / 32000 ) );
    }
    if ( name.endsWith( '.mp3' ) ) return Math.max( 1, Math.ceil( sizeBytes / 16000 ) );
    if ( name.endsWith( '.m4a' ) || name.endsWith( '.aac' ) || name.endsWith( '.mp4' ) ) return Math.max( 1, Math.ceil( sizeBytes / 16000 ) );
    if ( name.endsWith( '.ogg' ) || name.endsWith( '.opus' ) || name.endsWith( '.oga' ) ) return Math.max( 1, Math.ceil( sizeBytes / 4000 ) );
    if ( name.endsWith( '.flac' ) ) return Math.max( 1, Math.ceil( sizeBytes / 8333 ) );
    return Math.max( 1, Math.ceil( sizeBytes / 8000 ) );
}

function getEffectiveSTTRateLimit( config: OpenAIModelConfig, modelName?: string ): any {
    if ( modelName && config.individualLimit ) {
        const modelEntry = config.models.find( m => {
            const candidate = typeof m === 'string' ? m : ( m as any ).model;
            return stripFreeModifier( candidate ).normalizedId === stripFreeModifier( modelName ).normalizedId;
        } );
        if ( modelEntry && typeof modelEntry === 'object' && ( modelEntry as any ).rateLimit ) return ( modelEntry as any ).rateLimit;
    }
    return config.rateLimit;
}

export function proxyAudioStream( c: Context, upstreamResponse: Response, endpoint: string, providerId: string, selectedModel: string ): Response {
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
                        if ( value ) controller.enqueue( value );
                    }
                    console.info( `[${endpoint}] stream_complete provider=${providerId} model=${selectedModel}` );
                } catch ( err: any ) {
                    console.error( `[${endpoint}] stream_error provider=${providerId} model=${selectedModel}: ${err?.message || String( err )}` );
                    try {
                        const errorEvent = `event: error\ndata: ${JSON.stringify( { type: 'error', error: { type: 'upstream_error', message: err?.message || 'Stream error' } } )}\n\n`;
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
        headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' },
    } );
}
