import type { ResponsesRequest, ResponsesStreamState } from './types';
import { generateId } from './helpers';

export function createResponsesStreamState( request: ResponsesRequest, requestStartedAt: number ): ResponsesStreamState {
    return {
        responseId: generateId( 'resp' ),
        model: request.model,
        created: Math.floor( Date.now() / 1000 ),
        contentBlockIndex: 0,
        currentOutputIndex: 0,
        hasEmittedResponse: false,
        currentTextBlockOpen: false,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        finished: false,
        requestStartedAt,
        firstEmissionLogged: false,
        textItems: [],
        toolCalls: [],
        dsmlBuffer: '',
        reasoningItems: [],
        currentReasoningBlockOpen: false,
        reasoningBuffer: '',
        fileSearchCalls: [],
    };
}

export function emitResponsesStreamPreamble( state: ResponsesStreamState, out: string[] ): void {
    if ( state.hasEmittedResponse ) return;

    emitResponsesEvent( out, 'response.created', {
        type: 'response.created',
        response: {
            id: state.responseId,
            object: 'response',
            status: 'in_progress',
            created: state.created,
            model: state.model,
            output: [],
        },
    } );
    emitResponsesEvent( out, 'response.in_progress', {
        type: 'response.in_progress',
        response: {
            id: state.responseId,
            status: 'in_progress',
        },
    } );

    // Emit file_search_call items BEFORE any reasoning/text output so they
    // get the correct output_index order (file_search → reasoning → text).
    for ( const fsc of state.fileSearchCalls ) {
        emitResponsesEvent( out, 'response.output_item.added', {
            type: 'response.output_item.added',
            output_index: state.currentOutputIndex,
            item: {
                type: 'file_search_call',
                id: fsc.id,
                status: fsc.status,
                queries: fsc.queries,
                ...( fsc.results ? { results: fsc.results } : {} ),
            },
        } );
        emitResponsesEvent( out, 'response.output_item.done', {
            type: 'response.output_item.done',
            output_index: state.currentOutputIndex,
            item: {
                type: 'file_search_call',
                id: fsc.id,
                status: fsc.status,
                queries: fsc.queries,
                ...( fsc.results ? { results: fsc.results } : {} ),
            },
        } );
        state.currentOutputIndex++;
    }

    state.hasEmittedResponse = true;
}

export function emitResponsesEvent( out: string[], eventType: string, data: Record<string, unknown> ): void {
    out.push( `event: ${eventType}\ndata: ${JSON.stringify( data )}\n\n` );
}

/**
 * Convert SSE-formatted event strings to plain JSON strings suitable for
 * WebSocket text frames. Codex's WebSocket client expects plain JSON (no SSE
 * framing) and parses each text frame as `ResponsesStreamEvent` directly.
 */
export function sseEventsToWsFrames( sseEvents: string[] ): string[] {
    const frames: string[] = [];
    for ( const event of sseEvents ) {
        const dataMatch = event.match( /data: (\{.*\})\n/s );
        if ( dataMatch?.[1] ) {
            frames.push( dataMatch[1] );
        }
    }
    return frames;
}

export function emitResponsesDoneSentinel( out: string[] ): void {
    out.push( 'data: [DONE]\n\n' );
}

export function closeReasoningBlock( state: ResponsesStreamState, out: string[] ): void {
    if ( !state.currentReasoningBlockOpen ) return;
    const lastItem = state.reasoningItems[state.reasoningItems.length - 1];
    const accumulatedText = lastItem?.text ?? '';
    emitResponsesEvent( out, 'response.content_part.done', {
        type: 'response.content_part.done',
        output_index: state.currentOutputIndex,
        content_index: state.contentBlockIndex,
        part: { type: 'reasoning_summary', text: accumulatedText },
    } );
    emitResponsesEvent( out, 'response.output_item.done', {
        type: 'response.output_item.done',
        output_index: state.currentOutputIndex,
        item: { type: 'reasoning', id: lastItem?.itemId ?? '', summary: [{ type: 'summary_text', text: accumulatedText }] },
    } );
    state.currentOutputIndex++;
    state.contentBlockIndex = 0;
    state.currentReasoningBlockOpen = false;
}

export function finishResponsesStream( state: ResponsesStreamState, out: string[] ): void {
    if ( state.finished ) return;
    state.finished = true;

    // Close any lingering reasoning block first
    closeReasoningBlock( state, out );

    // Close any lingering text block
    if ( state.currentTextBlockOpen ) {
        const lastTextItem = state.textItems[state.textItems.length - 1];
        const accumulatedText = lastTextItem?.text ?? '';
        emitResponsesEvent( out, 'response.content_part.done', {
            type: 'response.content_part.done',
            output_index: state.currentOutputIndex,
            content_index: state.contentBlockIndex,
            part: { type: 'output_text', text: accumulatedText },
        } );
        emitResponsesEvent( out, 'response.output_item.done', {
            type: 'response.output_item.done',
            output_index: state.currentOutputIndex,
            item: {
                id: lastTextItem?.itemId,
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: accumulatedText
                    ? [ { type: 'output_text', text: accumulatedText, annotations: [] } ]
                    : [],
            },
        } );
        state.currentOutputIndex++;
        state.contentBlockIndex = 0;
        state.currentTextBlockOpen = false;
    }

    // Emit full lifecycle for any accumulated tool calls
    for ( const tc of state.toolCalls ) {
        if ( !tc.id ) continue;
        emitResponsesEvent( out, 'response.output_item.added', {
            type: 'response.output_item.added',
            output_index: state.currentOutputIndex,
            item: {
                type: 'function_call',
                id: tc.id,
                call_id: tc.id,
                name: tc.name,
                arguments: tc.arguments,
            },
        } );
        emitResponsesEvent( out, 'response.output_item.done', {
            type: 'response.output_item.done',
            output_index: state.currentOutputIndex,
            item: {
                type: 'function_call',
                id: tc.id,
                call_id: tc.id,
                name: tc.name,
                arguments: tc.arguments,
            },
        } );
        state.currentOutputIndex++;
    }

    // NOTE: response.completed is NOT emitted here. The caller emits it
    // with the full output list (including tool calls from state.toolCalls).
}
