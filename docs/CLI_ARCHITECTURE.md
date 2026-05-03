# CLI Architecture

The LLM Proxy CLI has been refactored for maintainability and modularity.

## Structure

```
src/cli/
├── index.ts              # Main CLI entry point
├── commands/             # Command implementations
│   ├── init.ts          # Initialize configuration
│   ├── start.ts         # Start the server
│   └── reset.ts         # Reset configuration
└── utils/               # Utility functions
    └── template.ts      # Template generation with dynamic schema fetching
```

## Key Features

### Dynamic Template Generation

The `template.ts` utility:
- Fetches the latest commit hash from GitHub API
- Generates JSONC (JSON with Comments) configuration files
- Includes metadata (commit hash, timestamp)
- References schema from GitHub or local node_modules

### Configuration File Name

All commands use `model.jsonc` as the default configuration filename:
- Comments are preserved for better user experience
- Easy editing with inline documentation
- Supports JSON5 syntax via `Bun.JSON5.parse()`

### Schema Reference

The template dynamically generates schema references:

**For CLI Usage (Downloaded Template):**
```json
"$schema": "https://raw.githubusercontent.com/dotlab-hq/ai-edge/refs/heads/main/schema.json"
```

**For NPM Package Installation:**
When installed as a package and linked with `bun link`, the schema reference automatically changes to reference the local node_modules.

### Commits and Versioning

Each generated template includes:
- Latest commit hash (7 characters)
- Generation date
- GitHub repository reference

This ensures templates are always in sync with the latest schema.

## Commands

### init

Initializes a new configuration:
```bash
bun src/cli/index.ts init
bun src/cli/index.ts init --skip-prompts
```

Features:
- Creates `model.jsonc` with comments
- Fetches latest commit from GitHub
- Includes setup instructions
- Warns about template format

### start

Starts the LLM Proxy server:
```bash
bun src/cli/index.ts start
bun src/cli/index.ts start --skip-prompts
```

Features:
- Loads configuration from `model.jsonc`
- Auto-loads cache statistics
- Configurable port (interactive prompt)
- Displays server configuration

### reset

Resets configuration to template:
```bash
bun src/cli/index.ts reset
bun src/cli/index.ts reset --skip-prompts
```

Features:
- Generates fresh template with latest commit
- Clears cache if possible
- Confirmation prompt (unless --skip-prompts)

## Local Development

### Link Package Locally

```bash
bun link
```

This registers the package globally so it can be used in other projects:

```bash
bun link ai-edge
```

### Build for Distribution

```bash
bun run build
```

This bundles the CLI into `dist/cli.js` (standalone executable).

## Template Comments

The generated `model.jsonc` includes helpful comments:

```jsonc
{
  // Section headers with descriptions
  // Field-level documentation
  // Default values explained
  // Optional configurations noted
}
```

This helps users understand:
- What each field does
- What values are expected
- Optional vs required fields
- Examples and defaults

## Error Handling

All commands:
- Show user-friendly error messages only
- Suppress stack traces (unless in development)
- Provide helpful next steps
- Handle missing configurations gracefully

## Future Enhancements

- [ ] Support for YAML/TOML configuration formats
- [ ] Interactive model builder
- [ ] Configuration validation and suggestions
- [ ] Health checks before startup
- [ ] Configuration migration tools
