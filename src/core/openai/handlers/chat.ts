import type { Context } from 'hono';
import type { BackendState, OpenAIModelConfig } from '../types';
import { normalizeToolSearchForEndpoint, prepareWebSearchForOpenAI } from '../proxyRequest';
import { prepareFileSearchForResponses } from '../fileSearch';
import { runProxyRequest } from '../providerLoop';
import { isSkillResolverReady, resolveOpenAIBody } from '../../SkillResolver';
import { convertResponsesRequestToChat } from '../../ResponsesConversion';
import { shouldUseOpenAICodeInterpreter, proxyCodeInterpreterRequest } from './codeInterpreter';

export async function handleChatCompletions( c: Context, state: BackendState ) {
    return handleOpenAIRequest( c, state, 'chat/completions' );
}

export async function handleCompletions( c: Context, state: BackendState ) {
    return runProxyRequest( { c, state, endpoint: 'completions' } ).then( r => r.response );
}

export async function handleOpenAIRequest( c: Context, state: BackendState, endpoint: string ) {
    const rawBody = await c.req.json().catch( () => ( {} ) );

    if ( isSkillResolverReady() ) {
        await resolveOpenAIBody( rawBody );
    }

    const normalizedBody = normalizeToolSearchForEndpoint( rawBody, endpoint );

    // Built-in OpenAI web-search tools are handled by the proxy. Resolve them
    // before converting Responses requests to Chat Completions; otherwise the
    // upstream model receives an unsupported native tool and cannot use search.
    const preparedWebSearch = await prepareWebSearchForOpenAI( normalizedBody, endpoint );
    if ( preparedWebSearch.errorResponse ) {
        return c.json( preparedWebSearch.errorResponse.body, preparedWebSearch.errorResponse.status as any );
    }
    const bodyWithWebSearch = preparedWebSearch.body;

    if ( shouldUseOpenAICodeInterpreter( bodyWithWebSearch ) ) {
        return proxyCodeInterpreterRequest( c, state, endpoint, bodyWithWebSearch );
    }

    if ( endpoint === 'responses' ) {
        // ponytail: Codex sends chat format to /v1/responses — skip request conversion
        // but keep originalResponsesBody so the response is converted back to Responses format.
        if ( bodyWithWebSearch.messages && !bodyWithWebSearch.input ) {
            return runProxyRequest( { c, state, endpoint: 'chat/completions', rawBody: bodyWithWebSearch, originalResponsesBody: bodyWithWebSearch } ).then( r => r.response );
        }
        const fileSearchContext = await prepareFileSearchForResponses( bodyWithWebSearch );
        const converted = convertResponsesRequestToChat( fileSearchContext.body );
        return runProxyRequest( { c, state, endpoint: 'chat/completions', rawBody: converted, originalResponsesBody: normalizedBody, fileSearchCalls: fileSearchContext.searchCalls } )
            .then( r => r.response );
    }

    return runProxyRequest( { c, state, endpoint, rawBody: bodyWithWebSearch } ).then( r => r.response );
}
