import { z } from '@hono/zod-openapi'

const RateLimitSpec = z.object( {
  // If any of these fields are omitted the system will treat that dimension as "unlimited".
  tokensPerMinute: z.number( { error: 'tokensPerMinute must be a number' } ).int( 'tokensPerMinute must be an integer' ).positive( 'tokensPerMinute must be > 0' ).optional(),
  requestsPerMinute: z.number( { error: 'requestsPerMinute must be a number' } ).int( 'requestsPerMinute must be an integer' ).positive( 'requestsPerMinute must be > 0' ).optional(),
  requestsPerDay: z.number( { error: 'requestsPerDay must be a number' } ).int( 'requestsPerDay must be an integer' ).positive( 'requestsPerDay must be > 0' ).optional(),
  // STT-specific: maximum seconds of audio that can be processed
  audioSecondsPerHour: z.number( { error: 'audioSecondsPerHour must be a number' } ).int( 'audioSecondsPerHour must be an integer' ).positive( 'audioSecondsPerHour must be > 0' ).optional().describe( 'Maximum seconds of audio that can be processed per hour (STT)' ),
  audioSecondsPerDay: z.number( { error: 'audioSecondsPerDay must be a number' } ).int( 'audioSecondsPerDay must be an integer' ).positive( 'audioSecondsPerDay must be > 0' ).optional().describe( 'Maximum seconds of audio that can be processed per day (STT)' ),
  tokensPerDay: z.number( { error: 'tokensPerDay must be a number' } ).int( 'tokensPerDay must be an integer' ).positive( 'tokensPerDay must be > 0' ).optional().describe( 'Maximum tokens per day' ),
} ).strict()

const RateLimitSchema = RateLimitSpec.optional()

const ImageModelsSchema = z.object( {
  image_generation: z.boolean( { error: 'image_generation must be a boolean' } ).optional(),
  image_editing: z.boolean( { error: 'image_editing must be a boolean' } ).optional(),
} ).strict().optional().describe( 'Provider image routing flags. Explicitly set image_generation and/or image_editing to enable those endpoints.' )

const EmbeddingsSchema = z.boolean( { error: 'embeddings must be a boolean' } ).optional().default( false ).describe( 'If true, this provider is reserved for embeddings routing and excluded from chat/completions/responses fallback' )

const STTSchema = z.boolean( { error: 'stt must be a boolean' } ).optional().default( false ).describe( 'If true, this provider is reserved for speech-to-text routing (audio/transcriptions, audio/translations) and excluded from chat/completions/responses/embeddings fallback' )

const TTSSchema = z.boolean( { error: 'tts must be a boolean' } ).optional().default( false ).describe( 'If true, this provider is reserved for text-to-speech routing (audio/speech) and excluded from chat/completions/responses/embeddings fallback' )

const SpooferSchema = z.boolean( { error: 'spoofer must be a boolean' } ).optional().default( false ).describe( 'If true, randomly generated IP spoofing headers (X-Forwarded-For, X-Real-IP, CF-Connecting-IP, etc.) are added to every upstream request' )

const ReasoningEffortSchema = z.enum( ['none', 'low', 'medium', 'high', 'xhigh', 'max'] )
const InputModalitySchema = z.enum( ['text', 'image', 'audio', 'file', 'pdf'] )
const OutputModalitySchema = z.enum( ['text', 'audio'] )
const ModalitiesSchema = z.object( {
  input: z.array( InputModalitySchema ).min( 1, 'input must contain at least one modality' ).optional().default( ['text', 'image', 'audio', 'file'] ).describe( 'Input modalities this provider or model accepts' ),
  output: z.array( OutputModalitySchema ).min( 1, 'output must contain at least one modality' ).optional().default( ['text'] ).describe( 'Output modalities this provider or model can produce' ),
} ).optional().default( { input: ['text', 'image', 'audio', 'file'], output: ['text'] } ).describe( 'Modalities this provider or model supports. Used for the model listing endpoint.' )

const ReasoningConfigFields = {
  reasoning_efforts: z.array( ReasoningEffortSchema ).min( 1, 'reasoning_efforts must contain at least one effort' ).optional().describe( 'Reasoning effort levels explicitly supported by this provider or model. Omit this field to disable proxy-injected reasoning defaults.' ),
  default_reasoning: ReasoningEffortSchema.optional().describe( 'Default reasoning effort used only when reasoning is explicitly configured for this provider or model.' ),
}

function validateReasoningConfig( val: { reasoning_efforts?: string[]; default_reasoning?: string }, ctx: z.RefinementCtx ) {
  if ( val.default_reasoning && Array.isArray( val.reasoning_efforts ) && !val.reasoning_efforts.includes( val.default_reasoning ) ) {
    ctx.addIssue( { code: z.ZodIssueCode.custom, path: ['default_reasoning'], message: 'default_reasoning must be one of reasoning_efforts' } )
  }
}

const ModelWithRateLimitSchema = z.object( {
  model: z.string( { error: 'model is required' } ).min( 1, 'model cannot be empty' ),
  rateLimit: RateLimitSpec,
  modalities: ModalitiesSchema,
  ...ReasoningConfigFields,
} ).strict().superRefine( validateReasoningConfig )

const OpenAIModelSchema = z.object( {
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
  randomRouting: z.boolean( { error: 'randomRouting must be a boolean' } ).default( true ).describe( 'If true (default), this provider participates in random routing: it can serve requests for models outside its own list, and in return it offers its other (sibling) models as a last resort when the requested model is exhausted across its group. If false, it only ever serves its own listed models' ),
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

const AnthropicModelSchema = z.object( {
  id: z.string( { error: 'id is required' } ).min( 1, 'id cannot be empty' ),
  name: z.string( { error: 'name is required' } ).min( 1, 'name cannot be empty' ),
  models: z.array( z.union( [z.string( { error: 'each model must be a string' } ), ModelWithRateLimitSchema] ) ).min( 1, 'models array must contain at least one model' ),
  modalities: ModalitiesSchema,
  individualLimit: z.boolean( { error: 'individualLimit must be a boolean' } ).default( false ),
  baseUrl: z.url( 'baseUrl must be a valid URL' ),
  apiKey: z.string( { error: 'apiKey is required' } ).min( 1, 'apiKey cannot be empty' ),
  rateLimit: RateLimitSchema,
  randomRouting: z.boolean( { error: 'randomRouting must be a boolean' } ).default( true ).describe( 'If true (default), this provider participates in random routing: it can serve requests for models outside its own list, and in return it offers its other (sibling) models as a last resort when the requested model is exhausted across its group. If false, it only ever serves its own listed models' ),
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

const StateAdapterObjectSchema = z.object( {
  redis_url: z.url( 'redis_url must be a valid URL' ).describe( 'Redis connection URL' ),
} )

const StateAdapterSchema = z.union( [
  z.enum( ['redis', 'memory'] ),
  StateAdapterObjectSchema,
] )

const WebSearchRateLimitSchema = z.object( {
  requestsPerMinute: z.number( { error: 'requestsPerMinute must be a number' } ).int( 'requestsPerMinute must be an integer' ).positive( 'requestsPerMinute must be > 0' ).optional(),
  requestsPerDay: z.number( { error: 'requestsPerDay must be a number' } ).int( 'requestsPerDay must be an integer' ).positive( 'requestsPerDay must be > 0' ).optional(),
  requestsPerMonth: z.number( { error: 'requestsPerMonth must be a number' } ).int( 'requestsPerMonth must be an integer' ).positive( 'requestsPerMonth must be > 0' ).optional(),
} ).optional()

const WebSearchDefaultsSchema = z.object( {
  maxResults: z.number( { error: 'maxResults must be a number' } ).int( 'maxResults must be an integer' ).positive( 'maxResults must be > 0' ).optional(),
  expandQueries: z.boolean( { error: 'expandQueries must be a boolean' } ).optional(),
  maxExpandedQueries: z.number( { error: 'maxExpandedQueries must be a number' } ).int( 'maxExpandedQueries must be an integer' ).positive( 'maxExpandedQueries must be > 0' ).optional(),
  parallelQueries: z.number( { error: 'parallelQueries must be a number' } ).int( 'parallelQueries must be an integer' ).positive( 'parallelQueries must be > 0' ).optional(),
  softTimeoutMs: z.number( { error: 'softTimeoutMs must be a number' } ).int( 'softTimeoutMs must be an integer' ).positive( 'softTimeoutMs must be > 0' ).optional(),
  providerTimeoutMs: z.number( { error: 'providerTimeoutMs must be a number' } ).int( 'providerTimeoutMs must be an integer' ).positive( 'providerTimeoutMs must be > 0' ).optional(),
} ).strict().optional()

const WebSearchProviderOptionsSchema = z.object( {
  maxResults: z.number( { error: 'maxResults must be a number' } ).int( 'maxResults must be an integer' ).positive( 'maxResults must be > 0' ).optional(),
  searchDepth: z.enum( ['basic', 'advanced'] ).optional(),
  includeRawContent: z.boolean( { error: 'includeRawContent must be a boolean' } ).optional(),
  includeAnswer: z.boolean( { error: 'includeAnswer must be a boolean' } ).optional(),
} ).strict().optional()

const WebSearchToolSchema = z.object( {
  type: z.enum( ['tavily', 'exa'] ),
  apiKey: z.string( { error: 'apiKey is required' } ).min( 1, 'apiKey cannot be empty' ),
  rateLimit: WebSearchRateLimitSchema,
  timeoutMs: z.number( { error: 'timeoutMs must be a number' } ).int( 'timeoutMs must be an integer' ).positive( 'timeoutMs must be > 0' ).optional(),
  options: WebSearchProviderOptionsSchema,
} )

const WebSearchSchema = z.object( {
  tools: z.array( WebSearchToolSchema ).min( 1, 'tools.webSearch.tools must contain at least one provider' ),
  defaults: WebSearchDefaultsSchema,
} ).optional()

const CodeInterpreterResourcesSchema = z.object( {
  cpu: z.number( { error: 'cpu must be a number' } ).int( 'cpu must be an integer' ).positive( 'cpu must be > 0' ).optional(),
  memory: z.number( { error: 'memory must be a number' } ).int( 'memory must be an integer' ).positive( 'memory must be > 0' ).optional(),
  disk: z.number( { error: 'disk must be a number' } ).int( 'disk must be an integer' ).positive( 'disk must be > 0' ).optional(),
} ).strict().optional()

const CodeInterpreterSchema = z.object( {
  type: z.enum( ['daytona'] ),
  apiKey: z.string( { error: 'apiKey is required' } ).min( 1, 'apiKey cannot be empty' ),
  apiUrl: z.url( 'apiUrl must be a valid URL' ).optional(),
  language: z.enum( ['python', 'typescript', 'javascript'] ).optional(),
  timeout: z.number( { error: 'timeout must be a number' } ).int( 'timeout must be an integer' ).positive( 'timeout must be > 0' ).optional(),
  target: z.enum( ['us', 'eu'] ).optional(),
  image: z.string( { error: 'image must be a string' } ).min( 1, 'image cannot be empty' ).optional(),
  snapshot: z.string( { error: 'snapshot must be a string' } ).min( 1, 'snapshot cannot be empty' ).optional(),
  resources: CodeInterpreterResourcesSchema,
  autoStopInterval: z.number( { error: 'autoStopInterval must be a number' } ).int( 'autoStopInterval must be an integer' ).min( 0, 'autoStopInterval must be >= 0' ).optional(),
  labels: z.record( z.string(), z.string( { error: 'labels values must be strings' } ) ).optional(),
  initialFiles: z.record( z.string(), z.string( { error: 'initialFiles values must be strings' } ) ).optional(),
} ).strict()

const VectorStoreSchema = z.object( {
  url: z.url( 'vectorStore.url must be a valid URL' ).describe( 'Base URL of the vector store API to proxy requests to' ),
  apiKey: z.string( { error: 'vectorStore.apiKey is required' } ).min( 1, 'vectorStore.apiKey cannot be empty' ).describe( 'API key sent as Authorization header to the vector store' ),
} ).strict().optional().describe( 'Vector store proxy configuration — forwards /v1/vector_stores and /v1/files requests to the target. Check out https://github.com/dotlab-hq/vector-store! :)' )

const RealtimeSchema = z.object( {
  url: z.url( 'realtime.url must be a valid URL' ).describe( 'Base URL of the OpenAI Realtime API to proxy requests to (e.g. https://api.openai.com/v1)' ),
  apiKey: z.string( { error: 'realtime.apiKey is required' } ).min( 1, 'realtime.apiKey cannot be empty' ).describe( 'API key sent as Authorization header to the Realtime API' ),
} ).strict().optional().describe( 'Realtime API proxy configuration — forwards /v1/realtime requests to the target endpoint' )

const StorageS3Schema = z.object( {
  endpoint: z.string().min( 1 ).describe( 'S3-compatible endpoint URL (e.g. https://s3.amazonaws.com or http://minio:9000)' ),
  region: z.string().default( 'auto' ).describe( 'AWS region for S3 (default auto for S3-compatible services like MinIO)' ),
  access_key: z.string().min( 1 ).describe( 'S3 access key ID' ),
  secret_key: z.string().min( 1 ).describe( 'S3 secret access key' ),
  bucket: z.string().min( 1 ).describe( 'S3 bucket name for skill and file storage' ),
  path_style: z.boolean().default( false ).describe( 'Use path-style S3 URLs (true for MinIO, false for AWS)' ),
} )

const StorageSchema = z.object( {
  mongo_uri: z.string().min( 1 ).describe( 'MongoDB connection URI for skills, skill versions, and file metadata (e.g. mongodb://localhost:27017)' ),
  s3: StorageS3Schema,
} ).optional().describe( 'Storage backend for skills and files — requires MongoDB for metadata and S3-compatible object storage for content' )

const ToolsSchema = z.object( {
  webSearch: WebSearchSchema.describe( 'Optional built-in web search providers used to satisfy OpenAI and Anthropic web search tool requests' ),
  code_interpreter: CodeInterpreterSchema.optional().describe( 'Alias for codeInterpreter (optional code interpreter provider)' ),
} ).optional()

export const ConfigSchema = z.object( {
  proxy: z.url( 'Proxy URL must be a valid URL' ).optional().describe( 'URL of the proxy server to forward requests to' ),
  spoofer: SpooferSchema,
  '$schema': z.url( 'Not a valid $schema URL' ).describe( 'URL to the JSON Schema that this configuration adheres to' ),
  'state-adapter': StateAdapterSchema.describe( 'Storage backend for state management - redis, memory, or { redis_url: string }' ),
  rateLimit: RateLimitSchema.describe( 'Global rate limit applied to all models unless individualLimit is true' ),
  storage: StorageSchema,
  tools: ToolsSchema.describe( 'Optional built-in proxy tools such as web search' ),
  vectorStore: VectorStoreSchema,
  realtime: RealtimeSchema,
  models: z.object( {
    openai: z.array( OpenAIModelSchema ).min( 1, 'At least one OpenAI config is required' ).optional().describe( 'OpenAI provider configurations. If omitted, no OpenAI models will be available' ),
    anthropic: z.array( AnthropicModelSchema ).min( 1, 'At least one Anthropic config is required' ).optional().describe( 'Anthropic provider configurations. If omitted, no Anthropic models will be available' ),
  } ),
} )

export type StateAdapter = z.infer<typeof StateAdapterSchema>
export type Config = z.infer<typeof ConfigSchema>
export { ConfigSchema as schema }



