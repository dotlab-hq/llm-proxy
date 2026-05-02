import { RedisCache } from './redis'
import { MemoryCache } from './memory'
import type { StateAdapter } from '@/schema'
import {CONFIG} from "@/utils/schema.lookup"


class DualWriteCache extends MemoryCache {
    private redis: RedisCache
    private pendingRedisWrites = new Map<string, Promise<void>>()
    
    constructor(redis_url: string) {
        super()
        this.redis = new RedisCache(redis_url)
    }
    
    override async setKey(key: string, value: any): Promise<void> {
        await super.setKey(key, value)
        this.scheduleRedisWrite(key, value)
    }
    
    override async getKey<T = any>(key: string): Promise<T | undefined> {
        return super.getKey<T>(key)
    }
    
    override async deleteKey(key: string): Promise<void> {
        await super.deleteKey(key)
        this.scheduleRedisDelete(key)
    }
    
    private scheduleRedisWrite(key: string, value: any): void {
        this.pendingRedisWrites.set(key, 
            this.redis.setKey(key, value).catch(err => {
                console.error(`[DualWriteCache] Redis write failed for key ${key}:`, err)
            })
        )
    }
    
    private scheduleRedisDelete(key: string): void {
        this.pendingRedisWrites.set(key,
            this.redis.deleteKey(key).catch(err => {
                console.error(`[DualWriteCache] Redis delete failed for key ${key}:`, err)
            })
        )
    }
    
    async flushPendingWrites(): Promise<void> {
        await Promise.allSettled(this.pendingRedisWrites.values())
        this.pendingRedisWrites.clear()
    }
}

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
        return new DualWriteCache(config.redis_url)
    }
    throw new Error('Invalid state adapter config')
}

export const CACHE = createCache(CONFIG['state-adapter']);
