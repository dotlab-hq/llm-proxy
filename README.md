# @dotlab-hq/llm-proxy

A local LLM API proxy server with rate limiting, caching, and multi-backend support. Works as an OpenAI-compatible API endpoint.

## Quick Start

### 1. Initialize Configuration

Create a new `model.jsonc` configuration file:

```bash
npx @dotlab-hq/llm-proxy init
```

Or skip prompts for automation:
```bash
npx @dotlab-hq/llm-proxy init --skip-prompts
```

### 2. Configure Your Models

Edit the generated `model.jsonc` and add your LLM providers:

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/dotlab-hq/llm-proxy/refs/heads/main/schema.json",
  "state-adapter": "memory",
  "models": {
    "openai": [
      {
        "id": "primary-openai",
        "name": "Primary Instance",
        "models": ["gpt-3.5-turbo", "gpt-4"],
        "individualLimit": true,
        "baseUrl": "https://api.openai.com/v1",
        "apiKey": "sk-your-api-key-here",
        "rateLimit": {
          "tokensPerMinute": 90000,
          "requestsPerMinute": 3500,
          "requestsPerDay": 200000
        }
      }
    ]
  }
}
```

### 3. Start the Server

```bash
npx @dotlab-hq/llm-proxy serve
```

The server starts on port **25789** by default. If busy, it auto-selects the next available port.

With `--skip-prompts`, the server starts immediately without prompts.

## CLI Commands

### `init`

Initialize a new `model.jsonc` configuration:

```bash
npx @dotlab-hq/llm-proxy init
npx @dotlab-hq/llm-proxy init --skip-prompts
```

### `serve`

Start the LLM Proxy server:

```bash
npx @dotlab-hq/llm-proxy serve
npx @dotlab-hq/llm-proxy serve --skip-prompts
```

**What it does:**
- Loads configuration from `model.jsonc`
- Starts on port 25789 (auto-selects next available if busy)
- Shows server configuration details
- Press Ctrl+C to stop

### Options

- `--skip-prompts` - Skip all interactive prompts and use defaults

## Configuration Format

### JSONC (JSON with Comments)

The configuration uses **JSONC** format for better user experience:
- ✅ Comments preserved for documentation
- ✅ Inline field explanations
- ✅ Example values shown
- ✅ Optional fields documented

### Dynamic Schema References

The generated schema reference always points to the latest version:

```jsonc
"$schema": "https://raw.githubusercontent.com/dotlab-hq/llm-proxy/refs/heads/main/schema.json"
```

When installed as an NPM package and linked locally, it references:
```jsonc
"$schema": "./node_modules/@dotlab-hq/llm-proxy/schema.json"
```

### Models Configuration

Each backend configuration includes:

```jsonc
{
  // Unique identifier for this backend
  "id": "primary-openai",
  // Display name
  "name": "Primary Instance",
  // Models this backend supports
  "models": ["gpt-3.5-turbo", "gpt-4"],
  // Track rate limits per instance
  "individualLimit": true,
  // API endpoint (OpenAI-compatible)
  "baseUrl": "https://api.openai.com/v1",
  // API authentication key
  "apiKey": "sk-your-api-key-here",
  // Rate limiting per backend
  "rateLimit": {
    "tokensPerMinute": 90000,
    "requestsPerMinute": 3500,
    "requestsPerDay": 200000
  }
}
```

## API Endpoints

### Get Cache Status

```bash
curl http://localhost:25789/
```

### Get Statistics

```bash
curl http://localhost:25789/stats
```

Auto-loaded on server startup with current rate limit usage.

### OpenAI Compatible Endpoints

- `POST /v1/chat/completions` - Chat completions
- `POST /v1/completions` - Text completions
- `POST /v1/embeddings` - Embeddings
- `GET /v1/models` - List available models

Example:

```bash
curl -X POST http://localhost:25789/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer llm-proxy" \
  -d '{
    "model": "gpt-3.5-turbo",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

## Development

### Run in Development Mode

```bash
bun run dev
```

### Type Checking

```bash
bun run types
```

### Running Tests

```bash
bun run testify
```

### Link Package Locally

```bash
bun link
```

Register locally for use in other projects:
```bash
bun link @dotlab-hq/llm-proxy
```

### Build CLI for Distribution

```bash
bun run build
```

Creates `dist/cli.js` (standalone CLI executable).

## Features

✅ **OpenAI Compatible** - Drop-in replacement for OpenAI API  
✅ **Multi-Backend** - Load balance across multiple providers  
✅ **Rate Limiting** - Granular token/request limits  
✅ **Caching** - Memory or Redis-backed state  
✅ **Auto-Load Stats** - Statistics loaded on server startup  
✅ **Modular CLI** - Separated commands and utilities  
✅ **Dynamic Templates** - Always uses latest schema from GitHub  
✅ **JSONC Configuration** - Comments for better documentation  
✅ **Bun Linked** - Local package development support  
✅ **TypeScript** - Full type safety  

## Error Handling

All errors are returned in OpenAI-compatible format:

- **400** - Invalid request (missing model, invalid parameters)
- **429** - Rate limit exceeded (tries next backend)
- **502** - All backends failed
- **503** - No backend configured

Stack traces are suppressed, only user-friendly messages shown.

## CLI Architecture

For detailed information about the CLI structure and development, see [CLI_ARCHITECTURE.md](./docs/CLI_ARCHITECTURE.md).

## Production Deployment

### 1. Build the CLI

```bash
bun run build
```

### 2. Use in Projects

```bash
npx @dotlab-hq/llm-proxy init
npx @dotlab-hq/llm-proxy serve
```

### Environment Variables

Use `${VAR_NAME}` in your `model.jsonc` to reference environment variables:

```jsonc
{
  "models": {
    "openai": [
      {
        "apiKey": "${OPENAI_API_KEY}",
        "baseUrl": "https://api.openai.com/v1",
        "models": ["gpt-3.5-turbo"]
      }
    ]
  }
}
```

## Architecture

- **Hono** - Fast, lightweight HTTP server
- **Zod** - Type-safe configuration validation  
- **@clack/prompts** - Beautiful interactive CLI
- **Bun** - Fast JavaScript runtime
- **Multi-backend** - Load balancing across providers
- **Rate Limiting** - Granular usage tracking
- **Caching** - Pluggable adapters (memory/Redis)

## License

MIT

---

Created with ❤️ by dotlab HQ
