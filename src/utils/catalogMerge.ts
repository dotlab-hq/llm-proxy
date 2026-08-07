import { fetchWithProxy } from '@/utils/proxyFetch';
import { CONFIG } from '@/utils/schema.lookup';
import { stripFreeModifier } from '@/utils/modelIds';
import type { ProviderConfig, CatalogModel, ProviderCatalog, UnifiedModelCatalog, UnifiedModelCatalogEntry } from './catalogTypes';
import {
    buildModelsUrl,
    supportsReasoningEfforts,
    getReasoningLevels,
    buildOpenCodeVariants,
    buildEffortSupport,
    getConfigModelMetas,
    normalizeCatalogModel,
    extractModelsFromPayload,
    buildAutoModelEntry,
    MODEL_CREATED_AT,
    AUTO_MODEL_ID,
} from './catalogHelpers';

export async function fetchProviderCatalog( config: ProviderConfig, proxyUrl?: string ): Promise<ProviderCatalog> {
    const providerName = config.id || config.name || 'provider';

    try {
        const response = await fetchWithProxy(
            buildModelsUrl( config.baseUrl ),
            {
                headers: {
                    Authorization: `Bearer ${config.apiKey}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
            },
            proxyUrl,
        );

        if ( !response.ok ) {
            throw new Error( `Model listing failed with status ${response.status}` );
        }

        const payload = await response.json();
        const models = extractModelsFromPayload( payload );
        const modelIds = models
            .map( model => normalizeCatalogModel( model, typeof model.id === 'string' ? model.id : providerName ).id )
            .filter( modelId => typeof modelId === 'string' && modelId.length > 0 );

        return {
            providerId: config.id,
            providerName,
            baseUrl: config.baseUrl,
            models,
            modelIds,
            lastFetchedAt: Date.now(),
            source: 'upstream',
        };
    } catch {
        const fallbackModelIds = config.models.map( modelEntry => ( typeof modelEntry === 'string' ? modelEntry : modelEntry.model ) );

        return {
            providerId: config.id,
            providerName,
            baseUrl: config.baseUrl,
            models: fallbackModelIds.map( modelId => ( { id: modelId } ) ),
            modelIds: fallbackModelIds,
            lastFetchedAt: Date.now(),
            source: 'config',
        };
    }
}

export function mergeUnifiedCatalog( providerCatalogs: ProviderCatalog[] ): UnifiedModelCatalog {
    const byId: Record<string, UnifiedModelCatalogEntry> = {};
    const byNormalizedId: Record<string, UnifiedModelCatalogEntry> = {};
    const orderedIds: string[] = [];
    const orderedIdSet = new Set<string>();
    const allProviderNames = new Set<string>();

    providerCatalogs.forEach( catalog => {
        const config = CONFIG.models.openai?.find( item => item.id === catalog.providerId );
        if ( !config ) {
            return;
        }
        // Skip non-chat providers from the model catalog (STT, TTS, embeddings, image gen/edit)
        const imageModels = config.imageModels;
        const isImageProvider = typeof imageModels === 'boolean'
            ? imageModels
            : ( typeof imageModels === 'object' && imageModels
                && ( imageModels.image_generation === true || imageModels.image_editing === true ) );
        if ( config.stt === true || config.tts === true || config.embeddings === true || isImageProvider ) {
            return;
        }
        allProviderNames.add( catalog.providerName );

        const upstreamModelsByNormalizedId = new Map<string, CatalogModel>();

        catalog.models.forEach( ( model, modelIndex ) => {
            const normalized = normalizeCatalogModel( model, catalog.modelIds[modelIndex] ?? `${catalog.providerName}-${modelIndex}` );
            const { normalizedId } = stripFreeModifier( normalized.id );
            if ( !upstreamModelsByNormalizedId.has( normalizedId ) ) {
                upstreamModelsByNormalizedId.set( normalizedId, model );
            }
        } );

        getConfigModelMetas( config ).forEach( configMeta => {
            const upstreamModel = upstreamModelsByNormalizedId.get( configMeta.normalizedId );
            const normalized = normalizeCatalogModel( upstreamModel ?? { id: configMeta.id }, configMeta.id );
            const normalizedId = configMeta.normalizedId;
            const isFree = configMeta.isFree;
            const existing = byNormalizedId[normalizedId];

            const supportedParameters = new Set<string>( ['max_tokens'] );
            if ( normalized.temperatureSupported ) {
                supportedParameters.add( 'temperature' );
            }
            if ( normalized.toolCallSupported ) {
                supportedParameters.add( 'tools' );
            }
            const reasoningSupported = normalized.reasoningSupported || supportsReasoningEfforts( configMeta.reasoningEfforts );
            if ( reasoningSupported ) {
                supportedParameters.add( 'reasoning' );
                supportedParameters.add( 'include_reasoning' );
                supportedParameters.add( 'reasoning_effort' );
                supportedParameters.add( 'thinking' );
                supportedParameters.add( 'output_reasoning' );
            }

            const inputModalities = config.modalities?.input ?? normalized.inputModalities;
            const outputModalities = config.modalities?.output ?? normalized.outputModalities;
            const hasVision = inputModalities.includes( 'image' );
            const isSttProvider = config.stt === true;

            const entry: UnifiedModelCatalogEntry = {
                id: configMeta.id,
                object: "model",
                name: configMeta.id,
                display_name: configMeta.id,
                description: normalized.description,
                created: MODEL_CREATED_AT,
                owned_by: 'ai-edge',
                architecture: {
                    input_modalities: inputModalities,
                    output_modalities: outputModalities,
                    tokenizer: 'Other',
                },
                top_provider: {
                    is_moderated: false,
                    context_length: typeof normalized.limit?.context === 'number'
                        ? normalized.limit.context
                        : typeof normalized.limit?.input === 'number'
                            ? normalized.limit.input
                            : 0,
                    max_completion_tokens: typeof normalized.limit?.output === 'number' ? normalized.limit.output : 0,
                },
                context_length: typeof normalized.limit?.context === 'number'
                    ? normalized.limit.context
                    : typeof normalized.limit?.input === 'number'
                        ? normalized.limit.input
                        : 0,
                supported_parameters: Array.from( supportedParameters ),
                modalities: {
                    input: inputModalities,
                    output: outputModalities,
                },
                capabilities: {
                    vision: hasVision,
                    image_input: hasVision,
                    reasoning: reasoningSupported,
                    thinking: reasoningSupported,
                    reasoning_levels: getReasoningLevels( configMeta.reasoningEfforts ),
                    stt: isSttProvider,
                },
                supports_vision: hasVision,
                supports_images: hasVision,
                supports_reasoning: reasoningSupported,
                reasoning: reasoningSupported,
                reasoning_effort: reasoningSupported,
                thinking: reasoningSupported,
                output_reasoning: reasoningSupported,
                opencode: {
                    ai_sdk_provider: 'ai-edge',
                    variants: buildOpenCodeVariants( configMeta.reasoningEfforts ),
                },
                effort: buildEffortSupport( configMeta.reasoningEfforts ),
                preferredIndex: configMeta.order,
                isFree,
                providers: existing ? Array.from( new Set( [...existing.providers, catalog.providerName] ) ) : [catalog.providerName],
            };

            if ( !existing || ( existing.isFree && !entry.isFree ) ) {
                byId[entry.id] = entry;
                byNormalizedId[normalizedId] = entry;
            } else {
                existing.providers = Array.from( new Set( [...existing.providers, catalog.providerName] ) );
                existing.isFree = existing.isFree || entry.isFree;
            }

            if ( !orderedIds.includes( normalizedId ) ) {
                orderedIds.push( normalizedId );
            }
        } );
    } );

    if ( orderedIds.length > 0 && !byNormalizedId[AUTO_MODEL_ID] ) {
        const autoEntry = buildAutoModelEntry( allProviderNames );
        byId[AUTO_MODEL_ID] = autoEntry;
        byNormalizedId[AUTO_MODEL_ID] = autoEntry;
        orderedIds.unshift( AUTO_MODEL_ID );
    }

    return {
        data: orderedIds.map( normalizedId => byNormalizedId[normalizedId] ).filter( Boolean ) as UnifiedModelCatalogEntry[],
        byId,
        byNormalizedId,
        providerCatalogs: Object.fromEntries( providerCatalogs.map( catalog => [catalog.providerId, catalog] ) ),
        modelIds: orderedIds,
        lastFetchedAt: Date.now(),
    };
}
