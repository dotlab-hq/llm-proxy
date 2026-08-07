import type { AnthropicMessage } from '../types/anthropic';
import type { GeminiPart } from './geminiTypes';
import { FALLBACK_THOUGHT_SIGNATURE } from './geminiTypes';

/**
 * Ensure ALL functionCall parts have thought_signature (REQUIRED by Gemini API).
 * The Gemini API strictly validates that every functionCall part in the request
 * has a thought_signature. Missing signatures result in 400 errors.
 * https://ai.google.dev/gemini-api/docs/thought-signatures
 */
function ensureThoughtSignaturesInParts( parts: unknown[] ): GeminiPart[] {
    if ( !Array.isArray( parts ) ) {
        return [];
    }

    let lastThoughtSignature: string | undefined;
    const result: GeminiPart[] = [];

    for ( const part of parts ) {
        if ( !part || typeof part !== 'object' ) {
            result.push( part as GeminiPart );
            continue;
        }

        const p = part as any;

        // Track thought signatures from thinking blocks
        if ( p.thinking ) {
            lastThoughtSignature = p.thought_signature;
        }

        // CRITICAL: Ensure EVERY functionCall has thought_signature
        if ( p.functionCall ) {
            const functionCall: GeminiPart['functionCall'] = {
                name: p.functionCall.name,
                args: p.functionCall.args || {},
            };

            // Use existing thought_signature or fallback to last one seen or generate
            const sig = p.functionCall.thought_signature || lastThoughtSignature;
            if ( sig ) {
                functionCall.thought_signature = sig;
            } else {
                console.warn( `[Gemini] functionCall "${p.functionCall.name}" missing thought_signature, using fallback` );
                functionCall.thought_signature = FALLBACK_THOUGHT_SIGNATURE;
            }

            result.push( { functionCall } as GeminiPart );
        } else {
            result.push( part as GeminiPart );
        }
    }

    return result;
}

/**
 * Reconstruct Gemini parts from Anthropic content, prioritizing native Gemini parts
 * stored in thinking block _provider_state.
 */
export function reconstructGeminiPartsFromMessage( content: any[] ): GeminiPart[] {
    // Check if thinking block has Gemini provider state (native parts from Gemini response)
    for ( const block of content ) {
        if ( block.type === 'thinking' && block._provider_state?.google?.parts ) {
            // Native Gemini parts are opaque provider state. Replay them verbatim:
            // thought blocks and thought_signature values are signed by Gemini and
            // must not be removed, rewritten, or supplemented before the next call.
            return block._provider_state.google.parts as GeminiPart[];
        }
    }

    // If no native Gemini parts, reconstruct from Anthropic content
    return reconstructGeminiPartsFromAnthropicContent( content );
}

/**
 * Reconstruct Gemini parts from Anthropic content blocks when native parts aren't available.
 * CRITICAL: thought_signature MUST be attached to every functionCall to satisfy Gemini API.
 */
function reconstructGeminiPartsFromAnthropicContent( content: any[] ): GeminiPart[] {
    const parts: GeminiPart[] = [];
    let lastThoughtSignature: string | undefined;

    for ( const block of content ) {
        if ( block.type === 'thinking' ) {
            // Capture thought_signature from thinking block for subsequent tool calls
            lastThoughtSignature = block._provider_state?.google?.thought_signature || block.signature;
            parts.push( { text: block.thinking } );
        } else if ( block.type === 'text' ) {
            parts.push( { text: block.text } );
        } else if ( block.type === 'tool_use' ) {
            const functionCall: GeminiPart['functionCall'] = {
                name: block.name,
                args: block.input as Record<string, unknown>,
            };

            // CRITICAL: Attach thought_signature from tool_use block OR from preceding thinking
            const blockThoughtSig = ( block as { _google?: { thought_signature?: string } } )?._google?.thought_signature;
            const thoughtSig = blockThoughtSig || lastThoughtSignature;

            if ( thoughtSig ) {
                functionCall.thought_signature = thoughtSig;
            } else {
                // Fallback: generate a signature if none found
                console.warn( `[Gemini] Tool call "${block.name}" missing thought_signature, using fallback` );
                functionCall.thought_signature = FALLBACK_THOUGHT_SIGNATURE;
            }

            parts.push( { functionCall } );
        } else if ( block.type === 'tool_result' ) {
            let response: Record<string, unknown>;
            if ( typeof block.content === 'string' ) {
                response = { result: block.content };
            } else if ( Array.isArray( block.content ) ) {
                const textContent = block.content
                    .filter( ( contentBlock: any ) => contentBlock.type === 'text' )
                    .map( ( contentBlock: any ) => contentBlock.text )
                    .join( '\n' );
                response = { result: textContent };
            } else {
                response = {};
            }

            parts.push( {
                functionResponse: {
                    name: block.tool_use_id,
                    response,
                },
            } );
        }
    }

    return parts;
}

/**
 * Convert Anthropic message content to Gemini parts (simple conversion without native state).
 */
export function convertAnthropicContentToGeminiParts( message: AnthropicMessage ): GeminiPart[] {
    const parts: GeminiPart[] = [];

    if ( typeof message.content === 'string' ) {
        if ( message.content ) {
            parts.push( { text: message.content } );
        }
        return parts;
    }

    if ( !Array.isArray( message.content ) ) {
        return parts;
    }

    let lastThoughtSignature: string | undefined;
    const hasToolUse = message.content.some( (b: any) => b.type === 'tool_use' );

    if (hasToolUse) {
        console.log(`[Gemini] Message role="${message.role}" has ${message.content.filter((b: any) => b.type === 'tool_use').length} tool_use blocks`);
    }

    for ( const block of message.content ) {
        if ( block.type === 'text' ) {
            parts.push( { text: block.text } );
        } else if ( block.type === 'thinking' ) {
            // Capture thought_signature for subsequent tool calls
            lastThoughtSignature = block.signature || block._provider_state?.google?.thought_signature;
            console.log(`[Gemini] Thinking block has signature: ${!!lastThoughtSignature}`);
            parts.push( { text: block.thinking } );
        } else if ( block.type === 'tool_use' ) {
            const functionCall: GeminiPart['functionCall'] = {
                name: block.name,
                args: block.input as Record<string, unknown>,
            };

            // Preserve thought_signature if present on tool_use block
            const blockThoughtSig = ( block as { _google?: { thought_signature?: string } } )?._google?.thought_signature;
            const sig = blockThoughtSig || lastThoughtSignature;

            if ( sig ) {
                functionCall.thought_signature = sig;
                console.log(`[Gemini] Tool "${block.name}" got signature: ${sig.slice(0, 20)}...`);
            } else {
                // Generate fallback to prevent Gemini API errors
                functionCall.thought_signature = FALLBACK_THOUGHT_SIGNATURE;
                console.warn( `[Gemini] Tool "${block.name}" missing signature, using fallback` );
            }

            parts.push( { functionCall } );
        } else if ( block.type === 'tool_result' ) {
            let response: Record<string, unknown>;
            if ( typeof block.content === 'string' ) {
                response = { result: block.content };
            } else if ( Array.isArray( block.content ) ) {
                const textContent = block.content
                    .filter( ( contentBlock: any ) => contentBlock.type === 'text' )
                    .map( ( contentBlock: any ) => contentBlock.text )
                    .join( '\n' );
                response = { result: textContent };
            } else {
                response = {};
            }

            parts.push( {
                functionResponse: {
                    name: block.tool_use_id,
                    response,
                },
            } );
        }
    }

    return parts;
}
