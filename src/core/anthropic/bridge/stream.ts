import type { Context } from 'hono';
import { stream } from 'hono/streaming';
import { createStreamState } from './processing';
import { consumeSseBlocks, processSseBlockSync } from './processing';
import { finishStreamSync, sendErrorEventSync, sendPingEventSync, flushOut } from './events';
import type { StreamWriter } from './types';

export async function streamOpenAIResponseAsAnthropic(
    c: Context,
    response: Response,
    originalModel: string,
    initialContentBlocks: Array<Record<string, any>> = [],
    requestStartedAt: number = Date.now()
): Promise<Response> {
    c.header( 'Content-Type', 'text/event-stream; charset=utf-8' );
    c.header( 'Transfer-Encoding', 'chunked' );
    c.header( 'Cache-Control', 'no-cache, no-transform' );
    c.header( 'Connection', 'keep-alive' );
    c.header( 'X-Accel-Buffering', 'no' );

    return stream( c, async ( streamWriter ) => {
        const reader = response.body?.getReader();
        if ( !reader ) {
            const out: string[] = [];
            sendErrorEventSync( out, new Error( 'Upstream response did not include a stream' ) );
            await streamWriter.write( out.join( '' ) );
            return;
        }

        const decoder = new TextDecoder();
        const state = createStreamState( originalModel, initialContentBlocks, requestStartedAt );
        const bufferChunks: string[] = [];
        let firstUpstreamChunkLogged = false;
        let clientDisconnected = false;
        const clientSignal = c.req.raw.signal;
        const onClientAbort = () => {
            clientDisconnected = true;
            reader.cancel( 'client disconnected' ).catch( () => { } );
        };
        clientSignal.addEventListener( 'abort', onClientAbort, { once: true } );

        try {
            const initialOut: string[] = [': stream-start\n\n'];
            sendPingEventSync( state, initialOut );
            await flushOut( initialOut, streamWriter );

            while ( !clientDisconnected ) {
                const { done, value } = await reader.read();
                if ( done ) {
                    break;
                }

                if ( value ) {
                    const decoded = decoder.decode( value, { stream: true } );
                    if ( !firstUpstreamChunkLogged ) {
                        firstUpstreamChunkLogged = true;
                        console.info( `[anthropic-bridge] first_upstream_chunk model=${originalModel} firstByteMs=${Date.now() - requestStartedAt}` );
                    }

                    bufferChunks.push( decoded );
                }

                const joined = bufferChunks.length === 1 ? bufferChunks[0]! : bufferChunks.join( '' );
                const { events, remainder } = consumeSseBlocks( joined );
                bufferChunks.length = 0;
                if ( remainder ) {
                    bufferChunks.push( remainder );
                }

                const out: string[] = [];
                for ( const eventBlock of events ) {
                    const finished = processSseBlockSync( eventBlock, state, out );
                    if ( finished ) {
                        await flushOut( out, streamWriter );
                        // Providers may leave the HTTP stream open after [DONE].
                        // Cancel it so the connection can be reused by the next request.
                        await reader.cancel( 'completed downstream stream' ).catch( () => { } );
                        return;
                    }
                }
                if ( out.length ) {
                    await flushOut( out, streamWriter );
                }
            }

            const tail = decoder.decode();
            if ( tail ) {
                bufferChunks.push( tail );
            }
            const joined = bufferChunks.length > 0 ? bufferChunks.join( '' ) : '';
            const { events } = consumeSseBlocks( joined );
            const out: string[] = [];
            for ( const eventBlock of events ) {
                const finished = processSseBlockSync( eventBlock, state, out );
                if ( finished ) {
                    await flushOut( out, streamWriter );
                    // Providers may leave the HTTP stream open after [DONE].
                    // Cancel it so the connection can be reused by the next request.
                    await reader.cancel( 'completed downstream stream' ).catch( () => { } );
                    return;
                }
            }

            if ( !state.finished ) {
                finishStreamSync( state, out );
            }
            if ( out.length ) {
                await flushOut( out, streamWriter );
            }
        } catch ( error: any ) {
            const errOut: string[] = [];
            // Guarantee the message is closed even when the upstream errors,
            // so clients don't hang waiting for message_stop.
            if ( !state.finished ) {
                finishStreamSync( state, errOut );
            }
            sendErrorEventSync( errOut, error instanceof Error ? error : new Error( String( error ) ) );
            try {
                await flushOut( errOut, streamWriter );
            } catch {
                /* ignore secondary error */
            }
        } finally {
            clientSignal.removeEventListener( 'abort', onClientAbort );
            if ( !clientDisconnected ) {
                console.info( `[anthropic-bridge] stream_complete model=${originalModel} totalMs=${Date.now() - requestStartedAt}` );
            }
            try { reader.releaseLock(); } catch { /* ignore */ }
        }
    } );
}

export async function relayUpstreamToStreamWriter(
    c: Context,
    response: Response,
    originalModel: string,
    streamWriter: StreamWriter,
    initialContentBlocks: Array<Record<string, any>> = [],
    requestStartedAt: number = Date.now()
): Promise<void> {
    const reader = response.body?.getReader();
    if ( !reader ) {
        const out: string[] = [];
        sendErrorEventSync( out, new Error( 'Upstream response did not include a stream' ) );
        await streamWriter.write( out.join( '' ) );
        return;
    }

    const decoder = new TextDecoder();
    const state = createStreamState( originalModel, initialContentBlocks, requestStartedAt );
    const bufferChunks: string[] = [];
    let firstUpstreamChunkLogged = false;
    let clientDisconnected = false;

    const clientSignal = c.req.raw.signal;
    const onClientAbort = () => {
        clientDisconnected = true;
        reader.cancel( 'client disconnected' ).catch( () => { } );
    };
    clientSignal.addEventListener( 'abort', onClientAbort, { once: true } );

    try {
        // Send an immediate keepalive so the client knows the connection is alive
        // while we wait for the upstream to produce its first chunk. Without this,
        // idle timeouts on the harness/client fire before data arrives, causing
        // spurious retries.
        {
            const pingOut: string[] = [];
            sendPingEventSync( state, pingOut );
            await flushOut( pingOut, streamWriter );
        }

        while ( !clientDisconnected ) {
            const { done, value } = await reader.read();
            if ( done ) {
                break;
            }

            if ( value ) {
                const decoded = decoder.decode( value, { stream: true } );
                if ( !firstUpstreamChunkLogged ) {
                    firstUpstreamChunkLogged = true;
                    console.info( `[anthropic-bridge] first_upstream_chunk model=${originalModel} firstByteMs=${Date.now() - requestStartedAt}` );
                }

                bufferChunks.push( decoded );
            }

            const joined = bufferChunks.length === 1 ? bufferChunks[0]! : bufferChunks.join( '' );
            const { events, remainder } = consumeSseBlocks( joined );
            bufferChunks.length = 0;
            if ( remainder ) {
                bufferChunks.push( remainder );
            }

            const out: string[] = [];
            for ( const eventBlock of events ) {
                const finished = processSseBlockSync( eventBlock, state, out );
                if ( finished ) {
                    await flushOut( out, streamWriter );
                    // Providers may leave the HTTP stream open after [DONE].
                    // Cancel it so the connection can be reused by the next request.
                    await reader.cancel( 'completed downstream stream' ).catch( () => { } );
                    return;
                }
            }
            if ( out.length ) {
                await flushOut( out, streamWriter );
            }
        }

        const tail = decoder.decode();
        if ( tail ) {
            bufferChunks.push( tail );
        }
        const joined = bufferChunks.length > 0 ? bufferChunks.join( '' ) : '';
        const { events } = consumeSseBlocks( joined );
        const out: string[] = [];
        for ( const eventBlock of events ) {
            const finished = processSseBlockSync( eventBlock, state, out );
            if ( finished ) {
                await flushOut( out, streamWriter );
                // Providers may leave the HTTP stream open after [DONE].
                // Cancel it so the connection can be reused by the next request.
                await reader.cancel( 'completed downstream stream' ).catch( () => { } );
                return;
            }
        }

        // ── GUARANTEED: finish the stream if upstream ended without sending message_stop ──
        if ( !state.finished ) {
            finishStreamSync( state, out );
        }
        if ( out.length ) {
            await flushOut( out, streamWriter );
        }
    } catch ( error: any ) {
        console.error( `[anthropic-bridge] stream_error model=${originalModel}: ${error?.message || String( error )}` );
        const errOut: string[] = [];

        // ── GUARANTEED: finish stream state even on error ──
        if ( !state.finished ) {
            finishStreamSync( state, errOut );
        }

        sendErrorEventSync( errOut, error instanceof Error ? error : new Error( String( error ) ) );
        try {
            await flushOut( errOut, streamWriter );
        } catch {
            /* ignore secondary error */
        }
    } finally {
        clientSignal.removeEventListener( 'abort', onClientAbort );
        if ( !clientDisconnected ) {
            console.info( `[anthropic-bridge] stream_complete model=${originalModel} totalMs=${Date.now() - requestStartedAt}` );
        }
        try { reader.releaseLock(); } catch { /* ignore */ }
    }
}
