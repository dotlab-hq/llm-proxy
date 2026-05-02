import { Hono } from 'hono';
import type { Context } from 'hono';
import { rateLimitManager } from './RateLimitManager';
import { CONFIG } from '@/utils/schema.lookup';
import type { Config } from '@/schema';

type OpenAIModelConfig = Config['models']['openai'][0];

export class OpenAIProxy {
    private app: Hono;
    private readonly rrIndexByKey = new Map<string, number>();

    constructor() {
        this.app = new Hono();
        this.setupRoutes();
    }

    getApp(): Hono {
        return this.app;
    }

    private setupRoutes(): void {
        this.app.get( '/v1/models', ( c: Context ) => this.handleModels( c ) );
        this.app.post( '/v1/responses', ( c: Context ) => this.handleResponses( c ) );
        this.app.post( '/v1/chat/completions', ( c: Context ) => this.handleChatCompletions( c ) );
        this.app.post( '/v1/embeddings', ( c: Context ) => this.handleEmbeddings( c ) );
        this.app.post( '/v1/completions', ( c: Context ) => this.handleCompletions( c ) );
    }

    private async handleModels( c: Context ) {
        try {
            const configs = CONFIG.models.openai;
            if ( !configs.length ) {
                return c.json( { error: 'No backend configured' }, 503 );
            }

            const firstConfig = this.getNextRoundRobinConfig( '__models__', configs );
            if ( !firstConfig ) {
                return c.json( { error: 'No backend configured' }, 503 );
            }

            const response = await fetch( `${firstConfig.baseUrl}/v1/models`, {
                headers: this.buildHeaders( firstConfig ),
                proxy: CONFIG.proxy ? CONFIG.proxy : undefined,
            } );
            const data = await response.json();
            return c.json( data, response.status as any );
        } catch ( error ) {
            return c.json( { error: 'Failed to fetch models' }, 500 );
        }
    }

    private async handleResponses( c: Context ) {
        return this.proxyRequest( c, 'responses' );
    }

    private async handleChatCompletions( c: Context ) {
        return this.proxyRequest( c, 'chat/completions' );
    }

    private async handleEmbeddings( c: Context ) {
        return this.proxyRequest( c, 'embeddings' );
    }

    private async handleCompletions( c: Context ) {
        return this.proxyRequest( c, 'completions' );
    }

    private getEffectiveRateLimit(config: OpenAIModelConfig): Config['rateLimit'] | undefined {
        if (config.individualLimit && config.rateLimit) {
            return config.rateLimit;
        }
        return CONFIG.rateLimit;
    }

    private async proxyRequest( c: Context, endpoint: string ) {
        const body = await c.req.json().catch( () => ( {} ) );
        const modelName = body.model;

        if ( !modelName || typeof modelName !== 'string' ) {
            return c.json( {
                error: {
                    message: 'Model is required and must be a string',
                    type: 'invalid_request_error'
                }
            }, 400 );
        }

        const matchingBackends = this.getBackendsForModel( modelName );
        if ( !matchingBackends.length ) {
            return c.json( {
                error: {
                    message: `Model not found: ${modelName}`,
                    type: 'invalid_request_error'
                }
            }, 400 );
        }

        const backends = this.getRoundRobinBackends( modelName, matchingBackends );

        for ( const config of backends ) {
            const tokens = this.calculateTokenCount( body );
            const rateLimit = this.getEffectiveRateLimit(config);
            const rateCheck = await rateLimitManager.checkAndConsume(
                config.id,
                tokens,
                rateLimit
            );

            if ( !rateCheck.allowed ) {
                continue;
            }

            try {
                const url = `${config.baseUrl}/v1/${endpoint}`;
                const response = await fetch( url, {
                    method: 'POST',
                    headers: this.buildHeaders( config ),
                    body: JSON.stringify( body ),
                    proxy: CONFIG.proxy ? CONFIG.proxy : undefined,
                } );

                if ( response.status === 429 ) {
                    continue;
                }

                const data = await response.json();
                return c.json( data, response.status as any );
            } catch ( error ) {
                continue;
            }
        }

        return c.json( {
            error: {
                message: 'All providers failed',
                type: 'internal_error'
            }
        }, 502 );
    }

    private getBackendsForModel( modelName: string ): OpenAIModelConfig[] {
        return CONFIG.models.openai.filter( config =>
            config.models.some( m => m === modelName )
        );
    }

    private getRoundRobinBackends( modelName: string, backends: OpenAIModelConfig[] ): OpenAIModelConfig[] {
        if ( backends.length <= 1 ) {
            return backends;
        }

        const key = `model:${modelName}`;
        const startIndex = this.getAndIncrementRoundRobinIndex( key, backends.length );
        return [
            ...backends.slice( startIndex ),
            ...backends.slice( 0, startIndex ),
        ];
    }

    private getNextRoundRobinConfig( key: string, backends: OpenAIModelConfig[] ): OpenAIModelConfig | undefined {
        if ( !backends.length ) {
            return undefined;
        }

        const index = this.getAndIncrementRoundRobinIndex( key, backends.length );
        return backends[index];
    }

    private getAndIncrementRoundRobinIndex( key: string, total: number ): number {
        if ( total <= 0 ) {
            return 0;
        }

        const current = this.rrIndexByKey.get( key ) ?? 0;
        const index = current % total;
        this.rrIndexByKey.set( key, ( index + 1 ) % total );
        return index;
    }

    private buildHeaders( config: OpenAIModelConfig ): Record<string, string> {
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${config.apiKey}`,
            'User-Agent': 'llm-proxy/1.0',
        };
    }

    private calculateTokenCount( body: any ): number {
        if ( !body ) return 100;
        if ( body.messages && Array.isArray( body.messages ) ) {
            return body.messages.reduce( ( sum: number, m: any ) =>
                sum + Math.ceil( ( m.content?.length || 0 ) / 4 ), 0
            ) || 100;
        }
        if ( body.input ) {
            return Math.ceil( ( body.input?.length || 0 ) / 4 ) || 100;
        }
        if ( body.prompt ) {
            return Math.ceil( ( body.prompt?.length || 0 ) / 4 ) || 100;
        }
        return 100;
    }
}

export const openAIProxy = new OpenAIProxy();
