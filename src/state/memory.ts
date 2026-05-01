import Cache from "../core/Cache";
import type { JSONable } from "../core/Cache";
import { CONFIG } from "@/utils/schema.lookup";
import type { Config } from "@/schema";

type OpenAIModelConfig = Config['models']['openai'][0];
type TransformedModel = Omit<OpenAIModelConfig, 'models'> & { 
    models: Array<{ model: string; rateLimit: OpenAIModelConfig['rateLimit'] }> 
};

export class MemoryCache extends Cache {
    constructor( initial?: JSONable ) {
        super( initial );
    }

    async getJson(): Promise<JSONable> {
        const data = this.extractConfigData();
        this.loadFromJSON(data);
        return this.toJSON();
    }

    async refresh(): Promise<JSONable> {
        const data = this.extractConfigData();
        this.loadFromJSON(data);
        return this.toJSON();
    }

    override async clearCache(): Promise<void> {
        this.store.clear();
    }

    async setJson( obj: JSONable ): Promise<void> {
        this.loadFromJSON( obj );
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

export default MemoryCache;