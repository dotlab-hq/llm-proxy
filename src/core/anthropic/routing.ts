import { stripFreeModifier } from '@/utils/modelIds';
import { configHasModel, isGeminiProvider, isImageOnlyConfig, isEmbeddingsEnabled, isSttEnabled, isTtsEnabled } from '../routing/shared';
import { providerSupportsModalities, modelEntrySupportsModalities } from './helpers';

type OpenAIModelConfig = any;
type Modality = string;

export { configHasModel, isGeminiProvider };

export function scoreProvider( config: OpenAIModelConfig, requestedModel: string, requiredModalities: readonly Modality[], providerStats: any ): number {
    const candidateModels = getCandidateModelsForProvider( config, requestedModel, requiredModalities );
    const modelName = candidateModels[0] ?? requestedModel;
    const stats = providerStats.getStats( config.id, modelName );
    const latencyScore = stats?.latencyEwmaMs ? Math.max( 0, 1 - stats.latencyEwmaMs / 30000 ) : 0.5;
    const successScore = stats?.successRateEwma ?? 1;
    const exactScore = configHasModel( config, requestedModel ) ? 1 : 0;
    return exactScore * 100 + successScore * 10 + latencyScore - ( stats?.consecutiveFailures ?? 0 );
}

export function getCandidateModelsForProvider( config: OpenAIModelConfig, requestedModel: string, requiredModalities: readonly Modality[] = ['text'] ): string[] {
    const explicitlyAuto = stripFreeModifier( requestedModel ).normalizedId === 'auto';
    const modelInThisProvider = config.models.some( ( m: any ) => {
        const candidate = typeof m === 'string' ? m : m.model;
        return stripFreeModifier( candidate ).normalizedId === stripFreeModifier( requestedModel ).normalizedId;
    } );
    const isAuto = explicitlyAuto || !modelInThisProvider;

    const filterHealthyText = ( models: string[] ): string[] => {
        return models;
    };

    if ( config.randomRouting === false && !isAuto && providerSupportsModalities( config, requiredModalities ) ) {
        return filterHealthyText( [requestedModel] );
    }
    const modelNames = config.models
        .filter( ( model: any ) => modelEntrySupportsModalities( config, model, requiredModalities ) )
        .map( ( m: any ) => ( typeof m === 'string' ? m : m.model ) );
    if ( !isAuto ) return filterHealthyText( [requestedModel] );
    const uniqueModels: string[] = filterHealthyText( Array.from( new Set( modelNames ) ) );
    if ( !uniqueModels.length ) return [];
    const startIndex = Math.floor( Math.random() * uniqueModels.length );
    return [...uniqueModels.slice( startIndex ), ...uniqueModels.slice( 0, startIndex )];
}

export function getOptimizedBackends( modelName: string, backends: OpenAIModelConfig[], requiredModalities: readonly Modality[], buildRouteCacheKey: ( m: string, mm: readonly Modality[] ) => string, getRoundRobinBackends: ( m: string, b: OpenAIModelConfig[] ) => OpenAIModelConfig[], providerStats: any ): OpenAIModelConfig[] {
    const candidates = getRoundRobinBackends( buildRouteCacheKey( modelName, requiredModalities ), backends );
    const sorted = candidates.sort( ( left, right ) => scoreProvider( right, modelName, requiredModalities, providerStats ) - scoreProvider( left, modelName, requiredModalities, providerStats ) );

    // Group isolation: fallback must stay within the primary backend's groupSpace.
    const primaryBackend = sorted[0];
    return primaryBackend
        ? sorted.filter( b => ( ( b as any ).groupSpace || 'default' ) === ( ( primaryBackend as any ).groupSpace || 'default' ) )
        : sorted;
}
