import { RedisCache } from './redis'
import { MemoryCache } from './memory'
import type { StateAdapter } from '@/schema'
import {CONFIG} from "@/utils/schema.lookup"


function createCache(config: StateAdapter) {
    if (typeof config === 'string') {
        switch (config) {
            case 'redis':
                throw new Error('redis_url is required when using string state-adapter')
            case 'memory':
                return new MemoryCache()
            default:
                throw new Error('Unknown state adapter: ' + config)
        }
    }
    if ('redis_url' in config) {
        return new RedisCache(config.redis_url)
    }
    throw new Error('Invalid state adapter config')
}

export const CACHE = createCache(CONFIG['state-adapter']);
