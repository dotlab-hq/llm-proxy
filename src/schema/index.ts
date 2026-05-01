import { z } from '@hono/zod-openapi'

const RateLimitSchema = z.object({
  tokensPerMinute: z.number({ error: 'tokensPerMinute is required' }).int('tokensPerMinute must be an integer').positive('tokensPerMinute must be > 0'),
  requestsPerMinute: z.number({ error: 'requestsPerMinute is required' }).int('requestsPerMinute must be an integer').positive('requestsPerMinute must be > 0'),
  requestsPerDay: z.number({ error: 'requestsPerDay must be a number' }).int('requestsPerDay must be an integer').positive('requestsPerDay must be > 0'),
})

const OpenAIModelSchema = z.object({
  id: z.string({ error: 'id is required' }).min(1, 'id cannot be empty'),
  name: z.string({ error: 'name is required' }).min(1, 'name cannot be empty'),
  models: z.array(z.string({ error: 'each model must be a string' })).min(1, 'models array must contain at least one model'),
  individualLimit: z.boolean({ error: 'individualLimit must be a boolean' }).default(false),
  baseUrl: z.url('baseUrl must be a valid URL'),
  apiKey: z.string({ error: 'apiKey is required' }).min(1, 'apiKey cannot be empty'),
  rateLimit: RateLimitSchema,
})

const StateAdapterObjectSchema = z.object({
  redis_url: z.url('redis_url must be a valid URL').describe('Redis connection URL'),
})

const StateAdapterSchema = z.union([
  z.enum(['redis', 'memory']),
  StateAdapterObjectSchema,
])

export const ConfigSchema = z.object({
  proxy:z.url('Proxy URL must be a valid URL').optional().describe('URL of the proxy server to forward requests to'),
  '$schema': z.url('Not a valid $schema URL').describe('URL to the JSON Schema that this configuration adheres to'),
  'state-adapter': StateAdapterSchema.describe('Storage backend for state management - redis, memory, or { redis_url: string }'),
  models: z.object({
    openai: z.array(OpenAIModelSchema).min(1, 'At least one OpenAI config is required'),
  }),
})

export type StateAdapter = z.infer<typeof StateAdapterSchema>
export type Config = z.infer<typeof ConfigSchema>
export { ConfigSchema as schema }
