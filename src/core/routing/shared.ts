import { stripFreeModifier } from '@/utils/modelIds';

type AnyProviderConfig = any;

export function isAutoModel( modelName: string ): boolean {
    return stripFreeModifier( modelName ).normalizedId === 'auto';
}

export function configHasModel( config: AnyProviderConfig, modelName: string ): boolean {
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

export function isStringContentOnlyProvider( config: AnyProviderConfig ): boolean {
    const baseUrl = typeof config?.baseUrl === 'string' ? config.baseUrl.toLowerCase() : '';
    const id = typeof config?.id === 'string' ? config.id.toLowerCase() : '';
    const name = typeof config?.name === 'string' ? config.name.toLowerCase() : '';
    return baseUrl.includes( 'sarvam.ai' ) || id.includes( 'sarvam' ) || name.includes( 'sarvam' );
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

