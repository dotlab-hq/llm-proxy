# @dotlab-hq/llm-proxy

A production-ready LLM API proxy server with rate limiting, caching, and multi-backend support. Works as an OpenAI-compatible API endpoint.

## Installation

```bash
bun install
```

## Quick Start

### 1. Initialize Configuration

Create a new `model.jsonc` configuration file with interactive prompts:

```bash
llm-proxy init
```

Or skip prompts for automation:
```bash
llm-proxy init --skip-prompts
```

The generated template:
- ✅ Includes helpful comments
- ✅ References latest schema from GitHub
- ✅ Shows latest commit hash
- ✅ JSONC format (JSON with Comments)

### 2. Configure Your Models

Edit the generated `model.jsonc` and add your LLM providers:

```jsonc
{
  // Schema reference (always latest from GitHub)
  "$schema": "https://raw.githubusercontent.com/dotlab-hq/llm-proxy/refs/heads/main/schema.json",
  
  // State adapter: "memory" or "redis"
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
llm-proxy start
```

The server will:
- ✅ Load configuration from `model.jsonc`
- ✅ Initialize cache (memory or Redis)
- ✅ Auto-load statistics on startup
- ✅ Start on port 3000 (or custom port via prompt)
- ✅ Gracefully shutdown when you press Ctrl+C

## CLI Commands

### `init`

Initialize a new `model.jsonc` configuration:

```bash
llm-proxy init
llm-proxy init --skip-prompts
```

**What it does:**
- Generates `model.jsonc` with helpful comments
- Fetches latest commit from GitHub
- Includes schema reference URL
- Shows configuration instructions

### `start`

Start the LLM Proxy server:

```bash
llm-proxy start
llm-proxy start --skip-prompts
```

**What it does:**
- Loads configuration from `model.jsonc`
- Prompts for custom port (optional)
- Shows server configuration details
- Starts HTTP server with graceful shutdown on Ctrl+C
- Press Ctrl+C to stop the server

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
curl http://localhost:3000/
```

### Get Statistics

```bash
curl http://localhost:3000/stats
```

Auto-loaded on server startup with current rate limit usage.

### OpenAI Compatible Endpoints

- `POST /v1/chat/completions` - Chat completions
- `POST /v1/completions` - Text completions
- `POST /v1/embeddings` - Embeddings
- `GET /v1/models` - List available models

Example:

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer nlm-proxy" \
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

### 2. Install Globally

```bash
npm install -g @dotlab-hq/llm-proxy
llm-proxy init
llm-proxy start
```

### 3. Use in Projects

```bash
npm install @dotlab-hq/llm-proxy
npx llm-proxy init
npx llm-proxy start
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
