import { z } from '@hono/zod-openapi'
import { RateLimitSpec, RateLimitSchema } from '@/schema/rateLimit'

export const ImageModelsSchema = z.object( {
  image_generation: z.boolean( { error: 'image_generation must be a boolean' } ).optional(),
  image_editing: z.boolean( { error: 'image_editing must be a boolean' } ).optional(),
} ).strict().optional().describe( 'Provider image routing flags. Explicitly set image_generation and/or image_editing to enable those endpoints.' )

export const EmbeddingsSchema = z.boolean( { error: 'embeddings must be a boolean' } ).optional().default( false ).describe( 'If true, this provider is reserved for embeddings routing and excluded from chat/completions/responses fallback' )

export const STTSchema = z.boolean( { error: 'stt must be a boolean' } ).optional().default( false ).describe( 'If true, this provider is reserved for speech-to-text routing (audio/transcriptions, audio/translations) and excluded from chat/completions/responses/embeddings fallback' )

export const TTSSchema = z.boolean( { error: 'tts must be a boolean' } ).optional().default( false ).describe( 'If true, this provider is reserved for text-to-speech routing (audio/speech) and excluded from chat/completions/responses/embeddings fallback' )

const ReasoningEffortSchema = z.enum( ['none', 'low', 'medium', 'high', 'xhigh', 'max'] )
const InputModalitySchema = z.enum( ['text', 'image', 'audio', 'file', 'pdf'] )
const OutputModalitySchema = z.enum( ['text', 'audio'] )

export const ModalitiesSchema = z.object( {
  input: z.array( InputModalitySchema ).min( 1, 'input must contain at least one modality' ).optional().default( ['text', 'image', 'audio', 'file'] ).describe( 'Input modalities this provider or model accepts' ),
  output: z.array( OutputModalitySchema ).min( 1, 'output must contain at least one modality' ).optional().default( ['text'] ).describe( 'Output modalities this provider or model can produce' ),
} ).optional().default( { input: ['text', 'image', 'audio', 'file'], output: ['text'] } ).describe( 'Modalities this provider or model supports. Used for the model listing endpoint.' )

export const ReasoningConfigFields = {
  reasoning_efforts: z.array( ReasoningEffortSchema ).min( 1, 'reasoning_efforts must contain at least one effort' ).optional().describe( 'Reasoning effort levels explicitly supported by this provider or model. Omit this field to disable proxy-injected reasoning defaults.' ),
  default_reasoning: ReasoningEffortSchema.optional().describe( 'Default reasoning effort used only when reasoning is explicitly configured for this provider or model.' ),
}

export function validateReasoningConfig( val: { reasoning_efforts?: string[]; default_reasoning?: string }, ctx: z.RefinementCtx ) {
  if ( val.default_reasoning && Array.isArray( val.reasoning_efforts ) && !val.reasoning_efforts.includes( val.default_reasoning ) ) {
    ctx.addIssue( { code: z.ZodIssueCode.custom, path: ['default_reasoning'], message: 'default_reasoning must be one of reasoning_efforts' } )
  }
}

export const ModelWithRateLimitSchema = z.object( {
  model: z.string( { error: 'model is required' } ).min( 1, 'model cannot be empty' ),
  rateLimit: RateLimitSpec,
  modalities: ModalitiesSchema,
  ...ReasoningConfigFields,
} ).strict().superRefine( validateReasoningConfig )

export const OpenAIModelSchema = z.object( {
  id: z.string( { error: 'id is required' } ).min( 1, 'id cannot be empty' ),
  name: z.string( { error: 'name is required' } ).min( 1, 'name cannot be empty' ),
  models: z.array( z.union( [z.string( { error: 'each model must be a string' } ), ModelWithRateLimitSchema] ) ).min( 1, 'models array must contain at least one model' ),
  modalities: ModalitiesSchema,
  imageModels: ImageModelsSchema,
  embeddings: EmbeddingsSchema,
  stt: STTSchema,
  tts: TTSSchema,
  individualLimit: z.boolean( { error: 'individualLimit must be a boolean' } ).default( false ),
  baseUrl: z.url( 'baseUrl must be a valid URL' ),
  apiKey: z.string( { error: 'apiKey is required' } ).min( 1, 'apiKey cannot be empty' ),
  rateLimit: RateLimitSchema,
  randomRouting: z.boolean( { error: 'randomRouting must be a boolean' } ).default( true ).describe( 'If false, disables this provider as a fallback for unknown models or exhausted exact-model providers' ),
  groupSpace: z.string( { error: 'groupSpace must be a string' } ).min( 1, 'groupSpace cannot be empty' ).default( 'default' ).describe( 'Provider group: auto-edge and fallback only route within the same group' ),
  extra: z.object( { isGemini: z.boolean( { error: 'extra.isGemini must be a boolean' } ).default( false ) } ).default( { isGemini: false } ),
  ...ReasoningConfigFields,
} )

  .superRefine( ( val, ctx ) => {
    const models = val.models || []
    const hasObject = models.some( m => typeof m === 'object' )
    const hasString = models.some( m => typeof m === 'string' )
    if ( hasObject && hasString ) {
      ctx.addIssue( { code: z.ZodIssueCode.custom, message: 'models must be all strings or all objects with { model, rateLimit }' } )
    }
    if ( val.imageModels && val.imageModels.image_generation !== true && val.imageModels.image_editing !== true ) {
      ctx.addIssue( { code: z.ZodIssueCode.custom, path: ['imageModels'], message: 'imageModels must enable at least one endpoint: image_generation or image_editing' } )
    }

    // STT providers must not also be embeddings or image-only providers
    if ( val.stt && val.embeddings ) {
      ctx.addIssue( { code: z.ZodIssueCode.custom, message: 'stt and embeddings cannot both be true on the same provider' } )
    }
    if ( val.stt && val.imageModels ) {
      ctx.addIssue( { code: z.ZodIssueCode.custom, path: ['stt'], message: 'stt cannot be true on an image-only provider (use imageModels)' } )
    }

    // TTS providers must not also be embeddings, image, or STT providers
    if ( val.tts && val.embeddings ) {
      ctx.addIssue( { code: z.ZodIssueCode.custom, message: 'tts and embeddings cannot both be true on the same provider' } )
    }
    if ( val.tts && val.imageModels ) {
      ctx.addIssue( { code: z.ZodIssueCode.custom, path: ['tts'], message: 'tts cannot be true on an image-only provider (use imageModels)' } )
    }
    if ( val.tts && val.stt ) {
      ctx.addIssue( { code: z.ZodIssueCode.custom, path: ['tts'], message: 'tts and stt cannot both be true on the same provider' } )
    }

    if ( hasObject ) {
      if ( val.rateLimit ) {
        ctx.addIssue( { code: z.ZodIssueCode.custom, message: 'backend-level rateLimit is forbidden when using per-model rate limits' } )
      }
      if ( val.individualLimit === false ) {
        ctx.addIssue( { code: z.ZodIssueCode.custom, message: 'individualLimit cannot be false when using per-model rate limits' } )
      }

      const providerHasReasoning = Object.prototype.hasOwnProperty.call( val, 'reasoning_efforts' ) || Object.prototype.hasOwnProperty.call( val, 'default_reasoning' )
      const modelHasReasoning = models.some( m => typeof m === 'object' && ( Object.prototype.hasOwnProperty.call( m, 'reasoning_efforts' ) || Object.prototype.hasOwnProperty.call( m, 'default_reasoning' ) ) )
      if ( providerHasReasoning && modelHasReasoning ) {
        ctx.addIssue( { code: z.ZodIssueCode.custom, message: 'reasoning config must be defined either at provider level or per-model level, not both' } )
      }
    }
    validateReasoningConfig( val, ctx )
  } )

export const AnthropicModelSchema = z.object( {
  id: z.string( { error: 'id is required' } ).min( 1, 'id cannot be empty' ),
  name: z.string( { error: 'name is required' } ).min( 1, 'name cannot be empty' ),
  models: z.array( z.union( [z.string( { error: 'each model must be a string' } ), ModelWithRateLimitSchema] ) ).min( 1, 'models array must contain at least one model' ),
  modalities: ModalitiesSchema,
  individualLimit: z.boolean( { error: 'individualLimit must be a boolean' } ).default( false ),
  baseUrl: z.url( 'baseUrl must be a valid URL' ),
  apiKey: z.string( { error: 'apiKey is required' } ).min( 1, 'apiKey cannot be empty' ),
  rateLimit: RateLimitSchema,
  randomRouting: z.boolean( { error: 'randomRouting must be a boolean' } ).default( true ).describe( 'If false, disables this provider as a fallback for unknown models or exhausted exact-model providers' ),
  groupSpace: z.string( { error: 'groupSpace must be a string' } ).min( 1, 'groupSpace cannot be empty' ).default( 'default' ).describe( 'Provider group: auto-edge and fallback only route within the same group' ),
  extra: z.object( { isGemini: z.boolean( { error: 'extra.isGemini must be a boolean' } ).default( false ) } ).default( { isGemini: false } ),
  ...ReasoningConfigFields,
} )

  .superRefine( ( val, ctx ) => {
    const models = val.models || []
    const hasObject = models.some( m => typeof m === 'object' )
    const hasString = models.some( m => typeof m === 'string' )
    if ( hasObject && hasString ) {
      ctx.addIssue( { code: z.ZodIssueCode.custom, message: 'models must be all strings or all objects with { model, rateLimit }' } )
    }
    if ( hasObject ) {
      if ( val.rateLimit ) {
        ctx.addIssue( { code: z.ZodIssueCode.custom, message: 'backend-level rateLimit is forbidden when using per-model rate limits' } )
      }
      if ( val.individualLimit === false ) {
        ctx.addIssue( { code: z.ZodIssueCode.custom, message: 'individualLimit cannot be false when using per-model rate limits' } )
      }

      const providerHasReasoning = Object.prototype.hasOwnProperty.call( val, 'reasoning_efforts' ) || Object.prototype.hasOwnProperty.call( val, 'default_reasoning' )
      const modelHasReasoning = models.some( m => typeof m === 'object' && ( Object.prototype.hasOwnProperty.call( m, 'reasoning_efforts' ) || Object.prototype.hasOwnProperty.call( m, 'default_reasoning' ) ) )
      if ( providerHasReasoning && modelHasReasoning ) {
        ctx.addIssue( { code: z.ZodIssueCode.custom, message: 'reasoning config must be defined either at provider level or per-model level, not both' } )
      }
    }
    validateReasoningConfig( val, ctx )
  } )



