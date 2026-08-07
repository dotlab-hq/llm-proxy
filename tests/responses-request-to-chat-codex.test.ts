import { describe, expect, it } from 'bun:test';
import { convertResponsesRequestToChat } from '../src/core/responses/requestToChat';

describe( 'Responses to Chat conversion for Codex requests', () => {
    it( 'does not forward Responses-only control fields to Chat providers', () => {
        const converted = convertResponsesRequestToChat( {
            model: 'gpt-5.6-terra',
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
            stream: true,
            store: true,
            include: ['reasoning.encrypted_content'],
            text: { format: { type: 'text' } },
            truncation: 'auto',
            prompt_cache_key: 'codex-session',
            metadata: { source: 'codex' },
            response_format: { type: 'text' },
        } as any );

        expect( converted ).toMatchObject( {
            model: 'gpt-5.6-terra',
            stream: true,
            response_format: { type: 'text' },
        } );
        expect( converted ).not.toHaveProperty( 'store' );
        expect( converted ).not.toHaveProperty( 'include' );
        expect( converted ).not.toHaveProperty( 'text' );
        expect( converted ).not.toHaveProperty( 'truncation' );
        expect( converted ).not.toHaveProperty( 'prompt_cache_key' );
        expect( converted ).not.toHaveProperty( 'metadata' );
        expect( converted ).not.toHaveProperty( 'stream_options' );
    } );

    it( 'normalizes tool-call assistant content for strict providers', () => {
        const converted = convertResponsesRequestToChat( {
            model: 'gpt-5.6-terra',
            input: [
                { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{}' },
                { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
            ],
        } as any );

        expect( converted.messages[0] ).toMatchObject( { role: 'assistant', content: '' } );
        expect( converted.messages[0] ).not.toHaveProperty( 'content', null );
    } );

    it( 'normalizes null content on generic assistant history items', () => {
        const converted = convertResponsesRequestToChat( {
            model: 'gpt-5.6-terra',
            input: [{ type: 'message', role: 'assistant', content: null }],
        } as any );

        expect( converted.messages[0] ).toMatchObject( { role: 'assistant', content: '' } );
    } );
} );
