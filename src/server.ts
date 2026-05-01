import { Hono } from 'hono'
import { logger } from 'hono/logger';
import { CACHE } from "./state";
import { openAIProxy } from "./core/OpenAIProxy";
import { CONFIG } from "./utils/schema.lookup";
import { rateLimitManager } from "./core/RateLimitManager";

const app = new Hono()
app.use(logger())

app.get('/', async (c) => c.json(await CACHE.getJson()))

app.get('/stats', async (c) => {
    const stats: Record<string, any> = {};
    
    for (const config of CONFIG.models.openai) {
        const usage = await rateLimitManager.getUsage(config.id);
        if (usage) {
            stats[config.id] = {
                ...usage,
                limits: config.rateLimit
            };
        }
    }
    
    return c.json(stats);
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
    return c.json({ message: 'Cache and stats cleared successfully' })
})

app.route('/', openAIProxy.getApp())

export default app