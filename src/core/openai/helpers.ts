import type { Context } from 'hono';
import { CONFIG } from '@/utils/schema.lookup';
import { fetchWithProxy } from '@/utils/proxyFetch';
import { stripFreeModifier } from '@/utils/modelIds';
import { applySpoofHeaders } from '@/utils/spoofer';
import type { OpenAIModelConfig } from './types';

export function buildApiUrl( config: OpenAIModelConfig, endpoint: string ): string {
    return `${normalizeBaseUrl( config.baseUrl )}/${endpoint}`;
}

export function normalizeBaseUrl( baseUrl: string ): string {
    return baseUrl.replace( /\/+$/, '' );
}

export function buildHeaders( config: OpenAIModelConfig ): Record<string, string> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
        'User-Agent': 'ai-edge/1.0',
    };
    if ( CONFIG.spoofer === true ) return applySpoofHeaders( headers );
    return headers;
}

/**
 * Remove the internal `extra.gemini` marker flag before sending the body
 * upstream — it is only used by the proxy for provider classification.
 * Returns the original body when nothing needs stripping (no allocation).
 */
export function stripGeminiOption( body: any ): any {
    if ( body?.extra?.gemini !== true ) return body;
    const { extra, ...rest } = body;
    const { gemini, ...remainingExtra } = extra;
    return Object.keys( remainingExtra ).length ? { ...rest, extra: remainingExtra } : rest;
}

// Hoisted module-level sets: collectTokenStrings runs per upstream candidate
// (multiple times per request), and allocating two Sets on every call adds
// avoidable garbage. These are read-only lookup tables.
const COUNTABLE_KEYS = new Set( [
    'content', 'text', 'input', 'prompt', 'instructions', 'messages', 'message',
    'choices', 'output', 'tool_calls', 'function_call', 'arguments', 'code', 'logs',
    'refusal', 'query', 'queries', 'variables', 'delta', 'file_data', 'file_url', 'image_url',
] );
const IGNORED_KEYS = new Set( [
    'annotations', 'metadata', 'usage', 'error', 'id', 'role', 'status', 'type', 'object',
    'model', 'created', 'created_at', 'finish_reason', 'index', 'system_fingerprint',
    'incomplete_details', 'reason',
] );

export function collectTokenStrings( value: any ): string[] {
    if ( value == null ) return [];
    if ( typeof value === 'string' ) return [value];
    if ( typeof value === 'number' || typeof value === 'boolean' ) return [];
    if ( Array.isArray( value ) ) return value.flatMap<string>( item => collectTokenStrings( item ) );
    if ( typeof value !== 'object' ) return [];

    return Object.entries( value ).flatMap<string>( ( [key, nestedValue] ) => {
        if ( IGNORED_KEYS.has( key ) ) return [];
        if ( COUNTABLE_KEYS.has( key ) ) return collectTokenStrings( nestedValue );
        return [];
    } );
}

export function calculateTokenCountFromStrings( values: string[], fallback: number = 100 ): number {
    const total = values.reduce( ( sum: number, value: string ) => sum + Math.max( 1, Math.ceil( value.length / 4 ) ), 0 );
    return total || fallback;
}

export function calculateEmbeddingTokenCount( input: any ): number {
    if ( input == null ) return 0;
    if ( typeof input === 'string' ) return Math.max( 1, Math.ceil( input.length / 4 ) );
    if ( typeof input === 'number' ) return 1;
    if ( Array.isArray( input ) ) {
        if ( input.length === 0 ) return 0;
        if ( input.every( item => typeof item === 'number' ) ) return input.length;
        return input.reduce( ( sum: number, item: any ) => sum + calculateEmbeddingTokenCount( item ), 0 );
    }
    if ( typeof input === 'object' ) {
        return collectTokenStrings( input ).reduce( ( sum: number, value: string ) => sum + Math.max( 1, Math.ceil( value.length / 4 ) ), 0 );
    }
    return 0;
}

export function calculateTokenCount( body: any ): number {
    if ( body?.input !== undefined ) {
        const embeddingTokens = calculateEmbeddingTokenCount( body.input );
        if ( embeddingTokens > 0 ) return embeddingTokens;
    }
    return calculateTokenCountFromStrings( extractRequestTokenStrings( body ) );
}

export function extractRequestTokenStrings( body: any, endpoint?: string ): string[] {
    if ( !body ) return [];
    if ( endpoint === 'completions' ) return collectTokenStrings( body.prompt );
    if ( endpoint === 'chat/completions' ) return collectTokenStrings( body.messages );
    if ( endpoint === 'responses' ) {
        return [ ...collectTokenStrings( body.input ), ...collectTokenStrings( body.instructions ), ...collectTokenStrings( body.prompt ) ];
    }
    if ( endpoint === 'embeddings' ) return collectTokenStrings( body.input );
    if ( endpoint === 'images/generations' || endpoint === 'images/edits' ) return collectTokenStrings( body.prompt );
    return collectTokenStrings( body );
}

export function extractResponseTokenStrings( endpoint: string, responseData: any ): string[] {
    if ( !responseData || typeof responseData !== 'object' ) return [];
    if ( endpoint === 'completions' || endpoint === 'chat/completions' ) return collectTokenStrings( responseData.choices );
    if ( endpoint === 'responses' ) return collectTokenStrings( responseData.output );
    return [];
}

export function buildUsageForEndpoint( endpoint: string, requestBody: any, responseData: any ): Record<string, any> | null {
    const promptTokens = calculateTokenCountFromStrings( extractRequestTokenStrings( requestBody, endpoint ), 0 );
    const completionTokens = calculateTokenCountFromStrings( extractResponseTokenStrings( endpoint, responseData ), 0 );

    if ( endpoint === 'responses' ) {
        return {
            input_tokens: promptTokens,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: completionTokens,
            output_tokens_details: { reasoning_tokens: 0 },
            total_tokens: promptTokens + completionTokens,
        };
    }
    if ( endpoint === 'embeddings' ) {
        const embeddingTokens = calculateEmbeddingTokenCount( requestBody?.input );
        return { prompt_tokens: embeddingTokens || promptTokens, total_tokens: embeddingTokens || promptTokens };
    }
    if ( endpoint === 'chat/completions' || endpoint === 'completions' ) {
        return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
    }
    return null;
}

export function attachUsageIfMissing( endpoint: string, requestBody: any, responseData: any ): any {
    if ( !responseData || typeof responseData !== 'object' || Array.isArray( responseData ) ) return responseData;
    if ( responseData.usage ) return responseData;
    const usage = buildUsageForEndpoint( endpoint, requestBody, responseData );
    if ( !usage ) return responseData;
    return { ...responseData, usage };
}

export function ensureToolCallThoughtSignatures( body: any ): any {
    if ( !body || typeof body !== 'object' ) return body;
    if ( !Array.isArray( body.messages ) ) return body;

    const FALLBACK_SIG = 'skip_thought_signature_validator';
    let changed = false;

    const messages = body.messages.map( ( message: any ) => {
        if ( !message || !Array.isArray( message.tool_calls ) ) return message;

        const toolCalls = message.tool_calls.map( ( toolCall: any ) => {
            if ( !toolCall || typeof toolCall !== 'object' ) return toolCall;

            const existingSig = toolCall.extra_content?.google?.thought_signature
                || toolCall.thought_signature
                || toolCall.function?.thought_signature;

            if ( existingSig ) {
                if ( toolCall.extra_content?.google?.thought_signature && toolCall.function?.thought_signature ) return toolCall;
                changed = true;
                return {
                    ...toolCall,
                    thought_signature: existingSig,
                    function: { ...( toolCall.function || {} ), thought_signature: existingSig },
                    extra_content: {
                        ...( toolCall.extra_content || {} ),
                        google: { ...( toolCall.extra_content?.google || {} ), thought_signature: existingSig },
                    },
                };
            }

            changed = true;
            return {
                ...toolCall,
                thought_signature: FALLBACK_SIG,
                function: { ...( toolCall.function || {} ), thought_signature: FALLBACK_SIG },
                extra_content: {
                    ...( toolCall.extra_content || {} ),
                    google: { ...( toolCall.extra_content?.google || {} ), thought_signature: FALLBACK_SIG },
                },
            };
        } );

        if ( toolCalls === message.tool_calls ) return message;
        return { ...message, tool_calls: toolCalls };
    } );

    if ( !changed ) return body;
    return { ...body, messages };
}

/**
 * Thinking-compatible OpenAI providers (notably DeepSeek via gateway
 * providers) require reasoning_content to be replayed on assistant tool-call
 * messages. Some upstreams omit it when converting Gemini/native responses.
 * Preserve whichever reasoning field we received and provide an empty value
 * when the provider only validates the field's presence.
 */
export function ensureToolCallReasoningContent( body: any ): any {
    if ( !body || typeof body !== 'object' || !Array.isArray( body.messages ) ) return body;
    let changed = false;
    const messages = body.messages.map( ( message: any ) => {
        if ( !message || message.role !== 'assistant' || !Array.isArray( message.tool_calls ) ) return message;
        if ( Object.prototype.hasOwnProperty.call( message, 'reasoning_content' ) ) return message;
        const reasoning = typeof message.reasoning === 'string'
            ? message.reasoning
            : typeof message.thinking === 'string' ? message.thinking : '';
        changed = true;
        return { ...message, reasoning_content: reasoning };
    } );
    return changed ? { ...body, messages } : body;
}

const REDIRECT_STATUSES = new Set( [301, 302, 303, 307, 308] );
export function isRedirectStatus( status: number ): boolean {
    return REDIRECT_STATUSES.has( status );
}

export function extractModelFromLocation( location: string ): string | null {
    try {
        if ( location.includes( 'kilo-auto/' ) ) {
            const match = location.match( /kilo-auto\/([^/]+)/ );
            if ( match ) return `kilo-auto/${match[1]}`;
        }
        const parts = location.split( '/' );
        const lastPart = parts[parts.length - 1];
        if ( lastPart && lastPart.length > 0 ) return lastPart;
    } catch {
        return null;
    }
    return null;
}

export function stripCompletionThoughtTags( payload: any ): any {
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
        for ( const field of [ 'reasoning', 'reasoning_content', 'thinking' ] ) {
            if ( typeof message?.[field] === 'string' ) message[field] = message[field].replace( /<\/?thought>/gi, '' );
            if ( typeof choice?.delta?.[field] === 'string' ) choice.delta[field] = choice.delta[field].replace( /<\/?thought>/gi, '' );
        }
        if ( typeof choice?.delta?.content === 'string' ) choice.delta.content = choice.delta.content.replace( /<\/?thought>/gi, '' );
        if ( typeof choice?.text === 'string' ) choice.text = choice.text.replace( /<\/?thought>/gi, '' );
    }
    return payload;
}
export async function parseResponsePayload( response: Response ): Promise<any> {
    const contentType = response.headers.get( 'content-type' ) ?? '';
    if ( contentType.includes( 'application/json' ) ) {
        return response.json().then( stripCompletionThoughtTags ).catch( () => ( { error: { message: 'Upstream returned invalid JSON', type: 'upstream_error' } } ) );
    }
    const text = await response.text().catch( () => '' );
    if ( !text ) return { error: { message: response.statusText || 'Upstream request failed', type: 'upstream_error' } };
    return text;
}

export function sendFailurePayload( c: Context, status: number, payload: any ) {
    if ( payload && typeof payload === 'object' ) return c.json( payload, status as any );
    return c.text( String( payload ?? 'Upstream request failed' ), status as any );
}

export function getEffectiveRateLimit( config: OpenAIModelConfig ): any {
    if ( config.individualLimit && config.rateLimit ) return config.rateLimit;
    return CONFIG.rateLimit;
}

export { fetchWithProxy, stripFreeModifier };
