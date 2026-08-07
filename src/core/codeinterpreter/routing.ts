import { stripFreeModifier } from '@/utils/modelIds';
import type {
    ProxyBackendConfig,
    ModelSelectionConfig,
} from './handler';

const AUTO_MODEL_ID = 'auto';

export function getBackendsForModel( config: ProxyBackendConfig & ModelSelectionConfig, modelName: string, targetGroup?: string ): any[] {
    const requestedNormalized = stripFreeModifier( modelName ).normalizedId;
    if ( config.embeddings === true ) {
        return [];
    }

    const explicitlyAuto = requestedNormalized === AUTO_MODEL_ID;
    const modelInThisProvider = config.models.some( m => {
        const candidate = typeof m === 'string' ? m : ( m as any ).model;
        return stripFreeModifier( candidate ).normalizedId === requestedNormalized;
    } );
    const isAutoModel = explicitlyAuto || !modelInThisProvider;

    // Group isolation: only applies to auto-edge (fallback) routing.
    if ( isAutoModel && targetGroup && ( config as any ).groupSpace !== targetGroup ) {
        return [];
    }

    return isAutoModel || config.models.some( m => {
        const candidate = typeof m === 'string' ? m : ( m as any ).model;
        return stripFreeModifier( candidate ).normalizedId === requestedNormalized;
    } ) || config.randomRouting !== false
        ? [config]
        : [];
}

export function getRoundRobinBackends( modelName: string, backends: any[] ): any[] {
    if ( backends.length <= 1 ) {
        return backends;
    }
    const startIndex = Math.floor( Math.random() * backends.length );
    return [
        ...backends.slice( startIndex ),
        ...backends.slice( 0, startIndex ),
    ];
}

export function getCandidateModelsForProvider( config: ModelSelectionConfig, requestedModel: string ): string[] {
    const requestedNormalized = stripFreeModifier( requestedModel ).normalizedId;
    const explicitlyAuto = requestedNormalized === AUTO_MODEL_ID;
    const modelInThisProvider = config.models.some( m => {
        const candidate = typeof m === 'string' ? m : ( m as any ).model;
        return stripFreeModifier( candidate ).normalizedId === requestedNormalized;
    } );
    // Unlisted models treated as auto-edge: pick best model from provider.
    const isAutoModel = explicitlyAuto || !modelInThisProvider;

    if ( config.randomRouting === false && !isAutoModel ) {
        return [requestedModel];
    }

    const modelNames = config.models.map( m => ( typeof m === 'string' ? m : ( m as any ).model ) );
    if ( !isAutoModel ) {
        return [requestedModel];
    }
    const uniqueModels: string[] = Array.from( new Set( modelNames ) );
    if ( !uniqueModels.length ) {
        return [requestedModel];
    }

    const startIndex = Math.floor( Math.random() * uniqueModels.length );
    return [
        ...uniqueModels.slice( startIndex ),
        ...uniqueModels.slice( 0, startIndex ),
    ];
}
