import type { OpenAIStreamChunk } from '@/package/claude-adapter';
import type { StreamState, SseOut } from './types';
import { generateUniqueToolId, getOrCreateThinkingSignature } from './types';
import {
    sendSseEventSync,
    sendContentBlockStopSync,
    sendPingEventSync,
    finishStreamSync,
} from './events';
import { processOpenAIChunkSync } from './chunk';

export function createStreamState( originalModel: string, initialContentBlocks: Array<Record<string, any>> = [], requestStartedAt: number = Date.now() ): StreamState {
    const serverToolUseCount = initialContentBlocks.filter( ( block ) => block?.type === 'server_tool_use' ).length;

    return {
        messageId: `msg_${Date.now().toString( 36 )}`,
        model: originalModel,
        responseModel: '',
        contentBlockIndex: 0,
        initialContentBlocks,
        initialContentBlocksEmitted: false,
        serverToolUseCount,
        currentToolCalls: new Map(),
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        hasStarted: false,
        textContent: '',
        textBlockOpen: false,
        reasoningEmittedStart: false,
        reasoningEmittedEnd: false,
        reasoningBlockOpen: false,
        reasoningSignature: undefined,
        openBlockTypes: new Map(),
        lastFinishReason: null,
        finished: false,
        streamStartedAt: requestStartedAt,
        firstSseEmissionLogged: false,
    };
}

export function consumeSseBlocks( buffer: string ): { events: string[]; remainder: string } {
    const normalized = buffer.replace( /\r\n/g, '\n' );
    const parts = normalized.split( '\n\n' );
    const remainder = parts.pop() ?? '';
    return {
        events: parts.filter( Boolean ),
        remainder,
    };
}

/**
 * Some Anthropic-compatible upstreams emit a null content-block index even
 * though the Anthropic stream schema requires a number. Keep this workaround
 * deliberately narrow: only a top-level `index: null` is repaired.
 */
export function normalizeAnthropicSseEvent<T>( event: T ): T {
    if ( event && typeof event === 'object' && !Array.isArray( event ) ) {
        const record = event as Record<string, unknown>;
        if ( record.index === null ) {
            return { ...record, index: 0 } as T;
        }
    }
    return event;
}

export function processSseBlockSync( block: string, state: StreamState, out: SseOut ): boolean {
    const lines = block
        .split( '\n' )
        .map( ( line ) => line.trim() );

    const dataLines = lines.filter( ( line ) => line.startsWith( 'data:' ) );

    if ( !dataLines.length ) {
        if ( lines.some( ( line ) => line.startsWith( ':' ) ) ) {
            sendPingEventSync( state, out );
        }
        return false;
    }

    const data = dataLines
        .map( ( line ) => line.slice( 5 ).trimStart() )
        .join( '\n' );

    if ( !data || data === '[DONE]' ) {
        if ( !state.finished ) {
            finishStreamSync( state, out );
        }
        return state.finished;
    }

    let chunk: OpenAIStreamChunk;
    try {
        chunk = normalizeAnthropicSseEvent( JSON.parse( data ) ) as OpenAIStreamChunk;
    } catch {
        return false;
    }

    return processOpenAIChunkSync( chunk, state, out );
}

export function emitInitialContentBlocksSync( state: StreamState, out: SseOut ): void {
    if ( state.initialContentBlocksEmitted || !state.initialContentBlocks.length ) {
        return;
    }

    for ( const block of state.initialContentBlocks ) {
        const index = state.contentBlockIndex;

        sendSseEventSync( state, out, {
            type: 'content_block_start',
            index,
            content_block: block,
        } );

        if ( block?.type === 'text' || block?.type === 'tool_use' || block?.type === 'server_tool_use' ) {
            state.openBlockTypes.set( index, block.type );
        }

        if ( block?.type === 'server_tool_use' && block?.input && typeof block.input === 'object' ) {
            sendSseEventSync( state, out, {
                type: 'content_block_delta',
                index,
                delta: {
                    type: 'input_json_delta',
                    partial_json: JSON.stringify( block.input ),
                },
            } );
        }

        sendContentBlockStopSync( state, index, out );
        state.contentBlockIndex += 1;
    }

    state.initialContentBlocksEmitted = true;
}

export { processOpenAIChunkSync, processToolCallDeltaSync } from './chunk';
