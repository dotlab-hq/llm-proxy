import { stripFreeModifier } from '@/utils/modelIds';

type AnyProviderConfig = any;

export function isAutoModel( modelName: string ): boolean {
    return stripFreeModifier( modelName ).normalizedId === 'auto';
}

export function configHasModel( config: AnyProviderConfig, modelName: string, normalizedModelName?: string ): boolean {
    const requestedNormalized = stripFreeModifier( modelName ).normalizedId;
    return config.models.some( ( m: any ) => {
        const candidate = typeof m === 'string' ? m : m.model;
        return stripFreeModifier( candidate ).normalizedId === requestedNormalized;
    } );
}

export function isEmbeddingsEnabled( config: AnyProviderConfig ): boolean {
    return config.embeddings === true;
}

export function isImageGenerationEnabled( config: AnyProviderConfig ): boolean {
    const imageModels = config.imageModels;
    return typeof imageModels === 'object' && imageModels?.image_generation === true;
}

export function isImageEditingEnabled( config: AnyProviderConfig ): boolean {
    const imageModels = config.imageModels;
    return typeof imageModels === 'object' && imageModels?.image_editing === true;
}

/** Providers with image_generation and/or image_editing must not serve text chat. */
export function isImageOnlyConfig( config: AnyProviderConfig ): boolean {
    const imageModels = config.imageModels;
    if ( typeof imageModels === 'boolean' ) {
        return imageModels;
    }
    return isImageGenerationEnabled( config ) || isImageEditingEnabled( config );
}

export function isSttEnabled( config: AnyProviderConfig ): boolean {
    return config.stt === true;
}

export function isTtsEnabled( config: AnyProviderConfig ): boolean {
    return config.tts === true;
}

export function isNonTextSpecializedConfig( config: AnyProviderConfig ): boolean {
    return isSttEnabled( config )
        || isTtsEnabled( config )
        || isEmbeddingsEnabled( config )
        || isImageOnlyConfig( config );
}

export function isGeminiProvider( config: AnyProviderConfig ): boolean {
  return config.extra?.isGemini === true;
}

export const DEFAULT_GROUP_SPACE = 'default';

export function getGroupSpace( config: AnyProviderConfig ): string {
  return config?.groupSpace || DEFAULT_GROUP_SPACE;
}

export function isStringContentOnlyProvider( config: AnyProviderConfig ): boolean {
    const baseUrl = typeof config?.baseUrl === 'string' ? config.baseUrl.toLowerCase() : '';
    const id = typeof config?.id === 'string' ? config.id.toLowerCase() : '';
    const name = typeof config?.name === 'string' ? config.name.toLowerCase() : '';
    return baseUrl.includes( 'sarvam.ai' ) || id.includes( 'sarvam' ) || name.includes( 'sarvam' );
}

export type InputModality = 'text' | 'image' | 'audio' | 'file' | 'pdf';

export const DEFAULT_INPUT_MODALITIES: readonly InputModality[] = ['text', 'image', 'audio', 'file'];

/**
 * Inspect a chat-style request body and return the input modalities it
 * actually uses (always includes 'text'). Used to prefer backends whose
 * declared `modalities.input` can serve the request, mirroring the
 * modality gating that already exists in the Anthropic flow.
 */
export function getRequiredInputModalities( body: any ): InputModality[] {
    const modalities = new Set<InputModality>( ['text'] );

    for ( const message of Array.isArray( body?.messages ) ? body.messages : [] ) {
        const content = message?.content;
        if ( !Array.isArray( content ) ) continue;

        for ( const block of content ) {
            if ( !block || typeof block !== 'object' ) continue;
            const type = ( block as Record<string, unknown> ).type;
            if ( type === 'image' || type === 'image_url' || type === 'input_image' ) {
                modalities.add( 'image' );
            } else if ( type === 'audio' || type === 'input_audio' ) {
                modalities.add( 'audio' );
            } else if ( type === 'file' || type === 'input_file' || type === 'document' ) {
                modalities.add( 'file' );
            }
        }
    }

    return Array.from( modalities );
}

/**
 * Whether a provider declares support for every required input modality.
 * String-content-only providers (e.g. Sarvam) are always routable — their
 * content is flattened to text downstream by normalizeMessagesContentToString.
 * Providers/models with omitted `modalities` fall back to the default
 * (text + image + audio + file), matching the config schema default.
 */
export function providerSupportsInputModalities( config: AnyProviderConfig, requiredModalities: readonly InputModality[] ): boolean {
    if ( isStringContentOnlyProvider( config ) ) return true;

    const providerModalities = new Set<InputModality>(
        config?.modalities?.input ?? DEFAULT_INPUT_MODALITIES,
    );
    if ( requiredModalities.every( modality => providerModalities.has( modality ) ) ) return true;

    // A per-model modality override may be broader than the provider default.
    return ( config?.models ?? [] ).some( ( model: any ) =>
        modelEntrySupportsInputModalities( config, model, requiredModalities ),
    );
}

/**
 * Whether a specific requested model supports the required input modalities.
 * Falls back to provider-level modalities when the model has no override.
 */
export function modelSupportsInputModalities( config: AnyProviderConfig, modelName: string, requiredModalities: readonly InputModality[] ): boolean {
    if ( isStringContentOnlyProvider( config ) ) return true;

    const requestedNormalized = stripFreeModifier( modelName ).normalizedId;
    const modelEntry = ( config?.models ?? [] ).find( ( model: any ) => {
        const candidate = typeof model === 'string' ? model : model?.model;
        return stripFreeModifier( candidate ).normalizedId === requestedNormalized;
    } );

    return modelEntry
        ? modelEntrySupportsInputModalities( config, modelEntry, requiredModalities )
        : providerSupportsInputModalities( config, requiredModalities );
}

export function modelEntrySupportsInputModalities(
    config: AnyProviderConfig,
    model: any,
    requiredModalities: readonly InputModality[],
): boolean {
    if ( isStringContentOnlyProvider( config ) ) return true;

    const modalities = new Set<InputModality>(
        typeof model === 'object' && model !== null
            ? ( model?.modalities?.input ?? config?.modalities?.input ?? DEFAULT_INPUT_MODALITIES )
            : ( config?.modalities?.input ?? DEFAULT_INPUT_MODALITIES ),
    );
    return requiredModalities.every( modality => modalities.has( modality ) );
}

export function normalizeMessagesContentToString( body: any ): any {
    if ( !body || typeof body !== 'object' || !Array.isArray( body.messages ) ) return body;
    let changed = false;

    const messages = body.messages.map( ( message: any ) => {
        if ( !message || typeof message !== 'object' ) return message;
        if ( typeof message.content === 'string' || message.content == null ) return message;

        const flattened = flattenMessageContentToString( message.content );
        changed = true;
        return { ...message, content: flattened };
    } );

    return changed ? { ...body, messages } : body;
}

function flattenMessageContentToString( content: unknown ): string {
    if ( content == null ) return '';
    if ( typeof content === 'string' ) return content;
    if ( Array.isArray( content ) ) {
        const parts: string[] = [];
        for ( const item of content ) {
            if ( typeof item === 'string' ) {
                parts.push( item );
                continue;
            }
            if ( !item || typeof item !== 'object' ) continue;
            const block = item as Record<string, unknown>;
            const type = typeof block.type === 'string' ? block.type : '';
            if ( typeof block.text === 'string' ) {
                parts.push( block.text );
            } else if ( type === 'image_url' || type === 'input_image' ) {
                parts.push( '[Image attachment]' );
            } else if ( type === 'input_audio' || type === 'audio' ) {
                parts.push( '[Audio attachment]' );
            } else if ( type === 'input_file' || type === 'file' || type === 'document' ) {
                parts.push( '[File attachment]' );
            }
        }
        return parts.join( '\n' );
    }
    if ( typeof content === 'object' ) {
        const block = content as Record<string, unknown>;
        if ( typeof block.text === 'string' ) return block.text;
        return '';
    }
    return String( content );
}

