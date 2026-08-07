import type { ResponsesRequest, ChatCompletionRequest, ChatMessage, ChatTool } from './types';
import {
    generateId,
    normaliseInputItems,
    extractToolCallsFromAssistantItem,
    convertToolsToChat,
    convertToolChoiceToChat,
    resolveReasoningEffort,
} from './helpers';

export function convertResponsesRequestToChat( request: ResponsesRequest ): ChatCompletionRequest {
    const messages = buildMessagesFromResponsesInput( request ).map( ( message ) => {
        // Zen's deserializer is stricter than OpenAI's schema and rejects
        // null/object message content. Codex can emit those values for
        // assistant/tool-call history, so enforce the Chat wire shape here.
        if ( typeof message.content === 'string' || Array.isArray( message.content ) ) return message;
        return { ...message, content: '' };
    } );
    const chatRequest: ChatCompletionRequest = {
        model: request.model,
        messages,
    };

    if ( request.max_output_tokens != null ) {
        chatRequest.max_tokens = request.max_output_tokens;
    }
    if ( request.temperature != null ) chatRequest.temperature = request.temperature;
    if ( request.top_p != null ) chatRequest.top_p = request.top_p;
    if ( request.stream != null ) chatRequest.stream = request.stream;
    if ( request.stop ) chatRequest.stop = request.stop;
    if ( request.presence_penalty != null ) chatRequest.presence_penalty = request.presence_penalty;
    if ( request.frequency_penalty != null ) chatRequest.frequency_penalty = request.frequency_penalty;
    if ( request.seed != null ) chatRequest.seed = request.seed;

    const tools = convertToolsToChat( request.tools );
    if ( tools.length > 0 ) chatRequest.tools = tools;

    const toolChoice = convertToolChoiceToChat( request.tool_choice );
    if ( toolChoice ) chatRequest.tool_choice = toolChoice;

    const reasoningEffort = resolveReasoningEffort( request );
    if ( reasoningEffort ) chatRequest.reasoning_effort = reasoningEffort;

    // ── Responses-only fields that must NOT leak into chat/completions ──
    const RESPONSES_ONLY_FIELDS = new Set<string>( [
        'input',
        'instructions',
        'reasoning',
        'max_output_tokens',
    ] );

    // Carry through only fields that are valid Chat Completions options. Codex
    // sends several Responses-only control fields (store, include, text,
    // truncation, prompt_cache_key, etc.). Forwarding those to compatible
    // /chat/completions providers causes a hard 400 before streaming starts.
    const CHAT_COMPAT_FIELDS = new Set( [
        'response_format', 'parallel_tool_calls', 'logprobs', 'top_logprobs',
        'user', 'service_tier', 'modalities', 'audio', 'prediction',
        'logit_bias', 'n', 'max_tokens', 'tools', 'tool_choice',
    ] );

    for ( const [key, value] of Object.entries( request ) ) {
        if ( CHAT_COMPAT_FIELDS.has( key ) && !( key in chatRequest ) && value !== undefined && !RESPONSES_ONLY_FIELDS.has( key ) ) {
            ( chatRequest as Record<string, unknown> )[key] = value;
        }
    }

    return chatRequest;
}

function buildMessagesFromResponsesInput( request: ResponsesRequest ): ChatMessage[] {
    const messages: ChatMessage[] = [];

    // `instructions` → system message
    if ( typeof request.instructions === 'string' && request.instructions.trim() ) {
        messages.push( { role: 'system', content: request.instructions } );
    }

    // Compatibility: some OpenAI-compatible clients send chat-style `messages`
    // to /v1/responses. Treat it as Responses input when `input` is absent.
    const legacyMessages = ( request as { messages?: unknown } ).messages;
    if ( request.input == null && Array.isArray( legacyMessages ) ) {
        for ( const message of legacyMessages ) {
            if ( !message || typeof message !== 'object' ) continue;
            const role = ( message as { role?: unknown } ).role;
            const normalizedRole = role === 'developer' ? 'system' : role === 'assistant' || role === 'tool' || role === 'system' ? role : 'user';
            const rawContent = ( message as { content?: unknown } ).content;
            messages.push( {
                ...( message as ChatMessage ),
                role: normalizedRole,
                // Some Responses clients send placeholder user messages with
                // null content while assembling a turn. Chat Completions
                // providers commonly reject those messages with HTTP 400.
                ...( normalizedRole === 'user' && rawContent == null ? { content: '' } : {} ),
            } );
        }
        return messages;
    }
    const inputItems = normaliseInputItems( request.input );

    for ( const item of inputItems ) {
        const mapped = mapInputItemToMessage( item );
        if ( mapped ) {
            if ( Array.isArray( mapped ) ) {
                messages.push( ...mapped );
            } else {
                messages.push( mapped );
            }
        }
    }

    return messages;
}

function mapInputItemToMessage( item: Record<string, unknown> ): ChatMessage | ChatMessage[] | null {
    const type = item.type as string | undefined;

    // ── function_call (model requesting to call a tool) ──
    if ( type === 'function_call' ) {
        return {
            role: 'assistant',
            // Some compatible providers reject null message content even
            // when the assistant message contains tool_calls.
            content: '',
            tool_calls: [{
                id: ( item.call_id as string ) || ( item.id as string ) || generateId( 'call' ),
                type: 'function',
                function: {
                    name: ( item.name as string ) || '',
                    arguments: ( item.arguments as string ) || '{}',
                },
            }],
        };
    }

    // ── function_call_output (tool result from caller) ──
    if ( type === 'function_call_output' ) {
        return {
            role: 'tool',
            tool_call_id: ( item.call_id as string ) || '',
            content: typeof item.output === 'string' ? item.output : JSON.stringify( item.output ?? '' ),
        };
    }

    // ── message items (role-based) ──
    const role = ( item.role as string ) || 'user';

    if ( role === 'system' || role === 'developer' ) {
        return { role: 'system', content: flattenContent( item.content ) };
    }

    if ( role === 'assistant' ) {
        // Assistant with tool_calls embedded in the output array
        if ( type === 'function_call' ) {
            // Already handled above, but guard
            return null;
        }
        const toolCalls = extractToolCallsFromAssistantItem( item );
        return {
            role: 'assistant',
            content: flattenContent( item.content ) ?? '',
            ...( toolCalls.length > 0 ? { tool_calls: toolCalls } : {} ),
        };
    }

    // user or default
    return { role: 'user', content: flattenContent( item.content ) ?? '' };
}

function flattenContent( content: unknown ): string | Array<Record<string, unknown>> | null {
    if ( content == null ) return null;
    if ( typeof content === 'string' ) return content;
    if ( Array.isArray( content ) ) {
        const hasImages = content.some( ( block ) => {
            if ( !block || typeof block !== 'object' ) return false;
            const t = block.type as string;
            return ( t === 'input_image' && typeof block.image_url === 'string' )
                || ( t === 'image_url' && typeof ( block.image_url ?? block.url ) === 'string' );
        } );

        // Use multimodal content array format when images are present
        if ( hasImages ) {
            const parts: Array<Record<string, unknown>> = [];
            for ( const block of content ) {
                if ( !block || typeof block !== 'object' ) continue;
                const t = block.type as string;
                if ( t === 'input_text' && typeof block.text === 'string' ) {
                    parts.push( { type: 'text', text: block.text } );
                } else if ( t === 'input_image' && typeof block.image_url === 'string' ) {
                    parts.push( { type: 'image_url', image_url: { url: block.image_url } } );
                } else if ( t === 'image_url' && typeof ( block.image_url ?? block.url ) === 'string' ) {
                    parts.push( { type: 'image_url', image_url: { url: block.image_url ?? block.url } } );
                } else if ( ( t === 'input_file' || t === 'file' || t === 'document' ) && ( block.file_id || block.id ) ) {
                    parts.push( { type: 'text', text: `[File: ${block.file_id || block.id} — file attachments not supported via chat completions]` } );
                } else if ( typeof block.text === 'string' ) {
                    parts.push( { type: 'text', text: block.text } );
                }
            }
            return parts.length > 0 ? parts : null;
        }

        // Text-only: join into a flat string
        const texts: string[] = [];
        for ( const block of content ) {
            if ( !block || typeof block !== 'object' ) continue;
            const t = block.type as string;
            if ( t === 'input_text' && typeof block.text === 'string' ) {
                texts.push( block.text );
            } else if ( ( t === 'input_file' || t === 'file' || t === 'document' ) && ( block.file_id || block.id ) ) {
                texts.push( `[File: ${block.file_id || block.id} — file attachments not supported via chat completions]` );
            } else if ( typeof block.text === 'string' ) {
                texts.push( block.text );
            }
        }
        return texts.join( '\n' ) || null;
    }
    if ( typeof content === 'object' && typeof ( content as any ).text === 'string' ) {
        return ( content as any ).text;
    }
    return null;
}


