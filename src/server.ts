import { Hono } from 'hono'
import { logger } from 'hono/logger';
import { serve } from '@hono/node-server';
import { CACHE } from "./state";
import { openAIProxy } from "./core/OpenAIProxy";
import { CONFIG } from "./utils/schema.lookup";
import { rateLimitManager } from "./core/RateLimitManager";

const app = new Hono()
app.use(logger())

// Auto-load cache/stats on startup
let cachedStats: Record<string, any> = {};

async function loadStats() {
    try {
        cachedStats = {};
        
        for (const config of CONFIG.models.openai) {
            const usage = await rateLimitManager.getUsage(config.id);
            if (usage) {
                cachedStats[config.id] = {
                    ...usage,
                    limits: config.rateLimit
                };
            }
        }
    } catch (error) {
        // If stats loading fails, continue with empty stats
        cachedStats = {};
    }
}

// Load stats on initialization
await loadStats();

app.get('/', async (c) => c.json(await CACHE.getJson()))

app.get('/stats', async (c) => {
    await loadStats();
    return c.json(cachedStats)
})

app.get('/clear', async (c) => {
    const confirm = c.req.query('confirm')
    if (confirm !== 'yes') {
        return c.json({ error: 'Confirmation required. Add ?confirm=yes to proceed.' }, 400)
    }
    await CACHE.clearCache()
    for (const config of CONFIG.models.openai) {
        await rateLimitManager.reset(config.id);
    }
    cachedStats = {};
    return c.json({ message: 'Cache and stats cleared successfully' })
})

app.route('/', openAIProxy.getApp())

const port = 25789;
serve({ fetch: app.fetch, port });

export default app