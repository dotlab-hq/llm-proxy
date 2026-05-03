import { Hono } from 'hono'
import { logger } from 'hono/logger';
import { serve } from '@hono/node-server';
import { CACHE } from "./state";
import { openAIProxy } from "./core/OpenAIProxy";
import { CONFIG } from "./utils/schema.lookup";
import { rateLimitManager } from "./core/RateLimitManager";

const app = new Hono()
app.use( logger() )

// Auto-load cache/stats on startup
let cachedStats: Record<string, any> = {};

async function loadStats() {
    try {
        cachedStats = {};

        for ( const config of CONFIG.models.openai ) {
            const usage = await rateLimitManager.getUsage( config.id );
            if ( usage ) {
                cachedStats[config.id] = {
                    ...usage,
                    limits: config.rateLimit
                };
            }
        }
    } catch ( error ) {
        // If stats loading fails, continue with empty stats
        cachedStats = {};
    }
}

// Load stats on initialization
await loadStats();

app.get( '/', async ( c ) => {
    const data = await CACHE.getJson();
    try {
        if ( data?.models?.openai && Array.isArray( data.models.openai ) ) {
            // mask apiKey for each configured provider
            data.models.openai = data.models.openai.map( ( m: any ) => ( {
                ...m,
                apiKey: m.apiKey ? '*****' : m.apiKey
            } ) )
        }
    } catch ( e ) {
        // ignore masking errors and return original data
    }
    return c.json( data )
} )

app.get( '/stats', async ( c ) => {
    await loadStats();
    return c.json( cachedStats )
} )

app.get( '/clear', async ( c ) => {
    const confirm = c.req.query( 'confirm' )
    if ( confirm !== 'yes' ) {
        return c.json( { error: 'Confirmation required. Add ?confirm=yes to proceed.' }, 400 )
    }
    await CACHE.clearCache()
    for ( const config of CONFIG.models.openai ) {
        await rateLimitManager.reset( config.id );
    }
    cachedStats = {};
    return c.json( { message: 'Cache and stats cleared successfully' } )
} )

// package version endpoint
app.get( '/api/v1/version', async ( c ) => {
    try {
        const pkg = await import( '../package.json', { assert: { type: 'json' } } as any )
        return c.json( { version: pkg.version } )
    } catch ( err ) {
        // fallback: read from file system
        try {
            const fs = await import( 'node:fs/promises' )
            const content = await fs.readFile( new URL( '../package.json', import.meta.url ), 'utf-8' )
            const parsed = JSON.parse( content )
            return c.json( { version: parsed.version } )
        } catch ( e ) {
            return c.json( { version: null } )
        }
    }
} )

// v1 models in OpenAI list format
app.get( '/v1/models', async ( c ) => {
    try {
        const modelsByName: Record<string, { providers: string[] }> = {}

        if ( CONFIG.models?.openai ) {
            for ( const cfg of CONFIG.models.openai ) {
                const providerName = cfg.id || cfg.name || 'provider'
                for ( const m of cfg.models ) {
                    if ( !modelsByName[m] ) modelsByName[m] = { providers: [] }
                    if ( !modelsByName[m].providers.includes( providerName ) ) modelsByName[m].providers.push( providerName )
                }
            }
        }

        const now = Math.floor( Date.now() / 1000 )
        const data = Object.entries( modelsByName ).map( ( [id, info] ) => ( {
            id,
            object: 'model',
            created: now,
            owned_by: info.providers.length === 1 ? info.providers[0] : 'multiple',
            providers: info.providers
        } ) )

        return c.json( { object: 'list', data } )
    } catch ( err ) {
        return c.json( { object: 'list', data: [] } )
    }
} )

app.route( '/', openAIProxy.getApp() )

const port = 25789;
serve( { fetch: app.fetch, port } );

export default app