import type { Context } from 'hono';
import {
    createResponsesStreamState,
    processChatStreamChunkForResponses,
    emitResponsesCompleted,
    emitResponsesDoneSentinel,
    type FileSearchCallItem,
} from '../ResponsesConversion';

/**
 * Send a Responses-format SSE error. Used when the upstream fails or model is
 * not found but the client expects SSE events (stream: true, wire_api: responses).
 * Without this, the client hangs waiting for `response.completed`.
 */
export function sendResponsesStreamError( modelName: string, errorMessage?: string ): Response {
    const encoder = new TextEncoder();
    const responseId = `resp_${Date.now().toString( 36 )}`;
    const created = Math.floor( Date.now() / 1000 );
    const events: string[] = [
        `event: response.created\ndata: ${JSON.stringify( {
            type: 'response.created',
            response: { id: responseId, object: 'response', status: 'in_progress', created, model: modelName, output: [] },
        } )}\n\n`,
        `event: response.in_progress\ndata: ${JSON.stringify( {
            type: 'response.in_progress',
            response: { id: responseId, status: 'in_progress' },
        } )}\n\n`,
    ];

    if ( errorMessage ) {
        events.push( `event: error\ndata: ${JSON.stringify( {
            type: 'error',
            error: { type: 'upstream_error', message: errorMessage },
        } )}\n\n` );
    }

    events.push( `event: response.completed\ndata: ${JSON.stringify( {
        type: 'response.completed',
        response: {
            id: responseId, object: 'response', status: 'completed', created, model: modelName,
            output: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
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

/**
 * Stream an upstream chat/completions SSE response, converting each chunk into
 * Responses-format SSE events and emitting a guaranteed response.completed.
 */
export async function streamResponsesConverted(
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
        upstreamReader.cancel( 'client disconnected' ).catch( () => {} );
    };
    clientSignal.addEventListener( 'abort', onClientAbort, { once: true } );

    const stream = new ReadableStream( {
        start( controller ) {
            let completedEmitted = false;

            const processChunk = ( buf: string ): string => {
                const out: string[] = [];
                // SSE permits CRLF line endings. Normalize them before looking
                // for event boundaries; otherwise an upstream using \r\n\r\n
                // produces no parsed chat chunks and we emit only an empty
                // response.completed event.
                const normalized = buf.replace( /\r\n/g, '\n' ).replace( /\r/g, '\n' );
                const parts = normalized.split( '\n\n' );
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
                    try {
                        const fallback = [
                            `event: response.completed\ndata: ${JSON.stringify( {
                                type: 'response.completed',
                                response: {
                                    id: responsesState.responseId, object: 'response', status: 'completed',
                                    created: responsesState.created, model: responsesState.model, output: [],
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
                        if ( value ) sseBuffer += decoder.decode( value, { stream: true } );
                        sseBuffer = processChunk( sseBuffer );
                    }
                    // Flush a UTF-8 character that may be buffered by the
                    // streaming decoder before processing the final SSE event.
                    const decoderTail = decoder.decode();
                    if ( decoderTail ) sseBuffer += decoderTail;
                    if ( sseBuffer.trim() && !clientDisconnected ) processChunk( sseBuffer + '\n\n' );
                } catch ( err: any ) {
                    console.error( `[${endpoint}] Streaming error: ${err?.message || String( err )} provider=${providerId} model=${selectedModel}` );
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
