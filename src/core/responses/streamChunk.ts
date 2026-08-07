import type { ResponsesStreamState } from './types';
import { generateId } from './helpers';
import {
    emitResponsesStreamPreamble,
    emitResponsesEvent,
    closeReasoningBlock,
    finishResponsesStream,
} from './streamState';

/**
 * Process one OpenAI chat completion SSE data chunk and emit corresponding
 * Responses-format SSE lines into `out`. Returns `true` when the stream is
 * complete (a `[DONE]` or `finish_reason` was encountered).
 */
export function processChatStreamChunkForResponses(
    chunk: Record<string, unknown> | null,
    state: ResponsesStreamState,
    out: string[],
): boolean {
    if ( state.finished ) return true;

    // Handle [DONE] sentinel
    if ( chunk === null ) {
        flushReasoningBuffer( state, out );
        parseDsmlToolCalls( state );
        finishResponsesStream( state, out );
        return true;
    }

    // Accumulate usage from the final chunk
    const usage = chunk.usage as Record<string, number> | undefined;
    if ( usage ) {
        state.inputTokens = usage.prompt_tokens ?? state.inputTokens;
        state.outputTokens = usage.completion_tokens ?? state.outputTokens;
        const promptDetails = chunk.usage as any;
        state.cachedInputTokens = promptDetails?.prompt_tokens_details?.cached_tokens ?? state.cachedInputTokens;
        state.reasoningTokens = promptDetails?.completion_tokens_details?.reasoning_tokens ?? state.reasoningTokens;
    }

    // Emit response.created on first chunk
    emitResponsesStreamPreamble( state, out );

    const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    if ( !choice ) {
        if ( usage ) {
            finishResponsesStream( state, out );
            return true;
        }
        return false;
    }

    const delta = choice.delta as Record<string, unknown> | undefined;
    const finishReason = choice.finish_reason as string | undefined;

    // Handle text content
    if ( delta ) {
        // Handle reasoning content (DeepSeek sends delta.reasoning_content, others may use delta.reasoning/delta.thinking)
        const reasoningContent = ( delta.reasoning_content ?? delta.reasoning ?? delta.thinking ) as string | undefined;
        if ( typeof reasoningContent === 'string' && reasoningContent.length > 0 ) {
            if ( !state.currentReasoningBlockOpen ) {
                const itemId = generateId( 'reason' );
                state.reasoningItems.push( { itemId, text: reasoningContent } );
                emitResponsesEvent( out, 'response.output_item.added', {
                    type: 'response.output_item.added',
                    output_index: state.currentOutputIndex,
                    item: {
                        type: 'reasoning',
                        id: itemId,
                        summary: [],
                    },
                } );
                emitResponsesEvent( out, 'response.content_part.added', {
                    type: 'response.content_part.added',
                    output_index: state.currentOutputIndex,
                    content_index: state.contentBlockIndex,
                    part: { type: 'reasoning_summary', text: '' },
                } );
                state.currentReasoningBlockOpen = true;
            } else {
                const last = state.reasoningItems[state.reasoningItems.length - 1];
                if ( last ) last.text += reasoningContent;
            }

            // ponytail: batch reasoning deltas — emit every ~80 chars so client gets live updates
            // without flooding WS buffers with one-char frames.
            state.reasoningBuffer = ( state.reasoningBuffer ?? '' ) + reasoningContent;
            if ( state.reasoningBuffer.length >= 80 ) {
                flushReasoningBuffer( state, out );
            }
        } else {
            flushReasoningBuffer( state, out );
        }

        const content = delta.content as string | undefined;

        if ( typeof content === 'string' && content.length > 0 ) {
            // Some reasoning models ignore the tool schema and print their
            // internal DeepSeek/DSML tool protocol as assistant text. Keep it
            // out of the client response and turn it back into a real tool
            // call once the invocation is complete.
            const visibleContent = consumeDsmlContent( content, state );
            const contentToEmit = visibleContent;
            if ( contentToEmit.length === 0 ) {
                // Continue to native tool-call processing below.
            } else {
            if ( !state.currentTextBlockOpen ) {
                closeReasoningBlock( state, out );
                const itemId = generateId( 'msg' );
                state.textItems.push( { itemId, text: contentToEmit } );
                emitResponsesEvent( out, 'response.output_item.added', {
                    type: 'response.output_item.added',
                    output_index: state.currentOutputIndex,
                    item: {
                        type: 'message',
                        id: itemId,
                        role: 'assistant',
                        status: 'in_progress',
                        content: [],
                    },
                } );
                emitResponsesEvent( out, 'response.content_part.added', {
                    type: 'response.content_part.added',
                    output_index: state.currentOutputIndex,
                    content_index: state.contentBlockIndex,
                    part: {
                        type: 'output_text',
                        text: '',
                    },
                } );
                state.currentTextBlockOpen = true;
            } else {
                const lastText = state.textItems[state.textItems.length - 1];
                if ( lastText ) lastText.text += contentToEmit;
            }

            emitResponsesEvent( out, 'response.output_text.delta', {
                type: 'response.output_text.delta',
                response_id: state.responseId,
                item_id: state.textItems[state.textItems.length - 1]?.itemId ?? '',
                output_index: state.currentOutputIndex,
                content_index: state.contentBlockIndex,
                delta: contentToEmit,
            } );
            }
        }

        // Accumulate tool calls from delta
        const toolCallDeltas = delta.tool_calls as Array<Record<string, unknown>> | undefined;
        if ( Array.isArray( toolCallDeltas ) ) {
            for ( const tcDelta of toolCallDeltas ) {
                const idx = tcDelta.index as number;
                if ( typeof idx !== 'number' ) continue;

                while ( state.toolCalls.length <= idx ) {
                    state.toolCalls.push( { id: '', name: '', arguments: '' } );
                }

                const existing = state.toolCalls[idx]!;
                const fnDelta = tcDelta.function as Record<string, unknown> | undefined;

                if ( tcDelta.id ) existing.id = tcDelta.id as string;
                if ( fnDelta?.name ) existing.name += fnDelta.name as string;
                if ( fnDelta?.arguments ) existing.arguments += fnDelta.arguments as string;
            }
        }
    }

    // Handle finish_reason — check regardless of whether delta exists
    if ( finishReason && finishReason !== 'null' ) {
        flushReasoningBuffer( state, out );
        parseDsmlToolCalls( state );
        closeReasoningBlock( state, out );
        if ( state.currentTextBlockOpen ) {
            const lastTextItem = state.textItems[state.textItems.length - 1];
            const accumulatedText = lastTextItem?.text ?? '';
            emitResponsesEvent( out, 'response.content_part.done', {
                type: 'response.content_part.done',
                output_index: state.currentOutputIndex,
                content_index: state.contentBlockIndex,
                part: {
                    type: 'output_text',
                    text: accumulatedText,
                },
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

        finishResponsesStream( state, out );
        return true;
    }

    return false;
}

/** Flush any accumulated reasoning buffer as a single delta frame. */
function flushReasoningBuffer( state: ResponsesStreamState, out: string[] ): void {
    const buf = state.reasoningBuffer;
    if ( !buf ) return;
    state.reasoningBuffer = '';
    emitResponsesEvent( out, 'response.reasoning_summary_text.delta', {
        type: 'response.reasoning_summary_text.delta',
        output_index: state.currentOutputIndex,
        content_index: state.contentBlockIndex,
        delta: buf,
    } );
}

const DSML_START = '<｜｜DSML｜｜tool_calls>';

function consumeDsmlContent( content: string, state: ResponsesStreamState ): string {
    const existing = state.dsmlBuffer;
    if ( existing ) {
        state.dsmlBuffer += content;
        return '';
    }
    const start = content.indexOf( DSML_START );
    if ( start < 0 ) return content;
    state.dsmlBuffer = content.slice( start );
    return content.slice( 0, start );
}

function parseDsmlToolCalls( state: ResponsesStreamState ): void {
    if ( !state.dsmlBuffer || state.toolCalls.length > 0 ) return;
    const invokeRe = /<｜｜DSML｜｜invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/?｜｜DSML｜｜invoke>/g;
    let match: RegExpExecArray | null;
    while ( ( match = invokeRe.exec( state.dsmlBuffer ) ) !== null ) {
        const args: Record<string, string> = {};
        const parameterRe = /<｜｜DSML｜｜parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/?｜｜DSML｜｜parameter>/g;
        let parameter: RegExpExecArray | null;
        while ( ( parameter = parameterRe.exec( match[2] ?? '' ) ) !== null ) {
            args[parameter[1]!] = parameter[2]!.trim();
        }
        state.toolCalls.push( {
            id: generateId( 'call' ),
            name: match[1]!,
            arguments: JSON.stringify( args ),
        } );
    }
}
