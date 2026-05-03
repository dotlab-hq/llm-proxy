import Cache from '../core/Cache'
import type { JSONable } from '../core/Cache'
import { CONFIG } from '@/utils/schema.lookup'
import type { Config } from "@/schema";
import { Redis } from 'ioredis'

const DUMP_KEY = '__cache_dump__'

type OpenAIModelConfig = Config['models']['openai'][0];
type TransformedModel = Omit<OpenAIModelConfig, 'models'> & { 
    models: Array<{ model: string; rateLimit: OpenAIModelConfig['rateLimit'] }> 
};

export class RedisCache extends Cache {
    private client: Redis
    private prefix: string

    constructor(redis_url: string, prefix = 'cache:') {
        super()
        this.client = new Redis(redis_url)
        this.prefix = prefix
    }

    private key(k: string) {
        return `${this.prefix}${k}`
    }

    override async setKey(key: string, value: any): Promise<void> {
        const body = JSON.stringify(value)
        await this.client.set(this.key(key), body)
        super.set(key, value)
    }

    override async getKey<T = any>(key: string): Promise<T | undefined> {
        const raw = await this.client.get(this.key(key))
        if (raw == null) return undefined
        try {
            return JSON.parse(raw) as T
        } catch {
            return undefined
        }
    }

    override async deleteKey(key: string): Promise<void> {
        await this.client.del(this.key(key))
        super.deleteKey(key)
    }

    async setJson(obj: JSONable): Promise<void> {
        const body = JSON.stringify(obj)
        await this.client.set(this.key(DUMP_KEY), body)
        this.loadFromJSON(obj)
    }

    async getJson(): Promise<JSONable> {
        const raw = await this.client.get(this.key(DUMP_KEY))
        if (!raw) {
            const data = this.extractConfigData();
            await this.setJson(data);
            return data;
        }
        try {
            const parsed = JSON.parse(raw) as JSONable
            this.loadFromJSON(parsed)
            return parsed
        } catch {
            const data = this.extractConfigData();
            await this.setJson(data);
            return data;
        }
    }

    async refresh(): Promise<JSONable> {
        const data = this.extractConfigData();
        await this.setJson(data);
        return data;
    }

    override async clearCache(): Promise<void> {
        await this.client.del(this.key(DUMP_KEY));
        this.store.clear();
    }

    private extractConfigData(): JSONable {
        const result: JSONable = {};
        if (CONFIG.models?.openai) {
            result.models = { openai: this.transformOpenAIModels(CONFIG.models.openai) as any };
        }
        return result;
    }

    private transformOpenAIModels(models: OpenAIModelConfig[]): OpenAIModelConfig[] | TransformedModel[] {
        return models.map(model => {
            if (model.individualLimit) {
                const { rateLimit: _, ...rest } = model;
                return {
                    ...rest,
                    models: model.models.map(m => ({
                        model: m,
                        rateLimit: model.rateLimit
                    }))
                };
            }
            return model;
        }) as any;
    }
}

export default RedisCache