import { Hono } from 'hono';
import { ProviderStatsTracker } from '../ProviderStatsTracker';
import { handleModels } from './handlers/models';
import { handleResponses, handleResponsesCompact, handleGetResponse } from './handlers/responses';
import { handleChatCompletions, handleCompletions, handleOpenAIRequest } from './handlers/chat';
import { handleEmbeddings } from './handlers/embeddings';
import { handleImageGenerations, handleImageEdits } from './handlers/images';
import { handleAudioTranscriptions, handleAudioTranslations } from './handlers/audio';
import { handleAudioSpeech } from './handlers/audioSpeech';
import { normalizeToolSearchForEndpoint } from './proxyRequest';
import { processUpstreamWithFallback } from './processUpstream';
import type { BackendState, OpenAIModelConfig } from './types';

export class OpenAIProxy {
    private app: Hono;
    private readonly rrIndexByKey = new Map<string, number>();
    private readonly providerStats = new ProviderStatsTracker();
    private readonly backendRouteCache = new Map<string, OpenAIModelConfig[]>();
    private readonly optimizedBackendCache = new Map<string, { backends: OpenAIModelConfig[]; expiresAt: number }>();

    constructor() {
        this.app = new Hono();
        // ponytail: hard cap request bodies at 25MB (413 if exceeded)
        const MAX_BODY_BYTES = 25 * 1024 * 1024;
        this.app.use( async ( c, next ) => {
            const len = Number( c.req.header( 'content-length' ) ?? 0 );
            if ( len > MAX_BODY_BYTES ) {
                return c.json( { error: { message: 'Request payload too large', type: 'invalid_request_error', code: 'payload_too_large' } }, 413 );
            }
            await next();
        } );
        this.setupRoutes();
    }

    getApp(): Hono {
        return this.app;
    }

    private state(): BackendState {
        return {
            rrIndexByKey: this.rrIndexByKey,
            providerStats: this.providerStats,
            backendRouteCache: this.backendRouteCache,
            optimizedBackendCache: this.optimizedBackendCache,
        };
    }

    private setupRoutes(): void {
        const s = () => this.state();
        this.app.get( '/v1/models', ( c ) => handleModels( c ) );
        this.app.post( '/v1/responses', ( c ) => handleResponses( c, ( cc, ep ) => handleOpenAIRequest( cc, s(), ep ) ) );
        this.app.post( '/v1/responses/compact', ( c ) => handleResponsesCompact( c ) );
        this.app.get( '/v1/responses/:id', ( c ) => handleGetResponse( c ) );
        this.app.post( '/v1/chat/completions', ( c ) => handleChatCompletions( c, s() ) );
        this.app.post( '/v1/embeddings', ( c ) => handleEmbeddings( c, s() ) );
        this.app.post( '/v1/completions', ( c ) => handleCompletions( c, s() ) );
        this.app.post( '/v1/images/generations', ( c ) => handleImageGenerations( c, s() ) );
        this.app.post( '/v1/images/edits', ( c ) => handleImageEdits( c, s() ) );
        this.app.post( '/v1/audio/transcriptions', ( c ) => handleAudioTranscriptions( c, s() ) );
        this.app.post( '/v1/audio/translations', ( c ) => handleAudioTranslations( c, s() ) );
        this.app.post( '/v1/audio/speech', ( c ) => handleAudioSpeech( c, s() ) );
    }

    // Public hook retained for external callers (tests, ResponsesWebSocket path).
    public normalizeToolSearchForEndpoint( body: any, endpoint: string ): any {
        return normalizeToolSearchForEndpoint( body, endpoint );
    }

    public async processUpstreamWithFallback( body: any, endpoint: string, options: {
        responseId: string;
        model: string;
        stream?: boolean;
        targetGroup?: string;
    } ): Promise<{ status: number; payload?: any; response?: Response; providerId?: string; selectedModel?: string }> {
        return processUpstreamWithFallback( this.state(), body, endpoint, options );
    }
}

export const openAIProxy = new OpenAIProxy();
