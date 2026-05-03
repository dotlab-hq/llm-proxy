import path from 'path';

const GITHUB_API = 'https://api.github.com/repos/dotlab-hq/ai-edge/commits?per_page=1';

interface LatestCommit {
  sha: string;
  date: string;
}

export async function getLatestCommit(): Promise<LatestCommit> {
  try {
    const response = await fetch( GITHUB_API );
    if ( !response.ok ) throw new Error( 'Failed to fetch latest commit' );

    const data = await response.json() as any[];
    if ( !data || data.length === 0 ) throw new Error( 'No commits found' );

    return {
      sha: data[0].sha.substring( 0, 7 ),
      date: new Date().toISOString().split( 'T' )[0]?.toString() || '',
    };
  } catch ( error ) {
    console.warn( '⚠️  Could not fetch latest commit, using default' );
    return {
      sha: 'main',
      date: new Date().toISOString().split( 'T' )[0]?.toString() || '',
    };
  }
}

export async function getSchemaReference(): Promise<string> {
  // Check if running from node_modules (installed package)
  const modulePath = process.cwd();
  const isNodeModule = modulePath.includes( 'node_modules' );

  if ( isNodeModule ) {
    return '../schema.json'; // Reference local schema in node_modules
  }

  const commit = await getLatestCommit();

  return `https://raw.githubusercontent.com/dotlab-hq/ai-edge/${commit.sha}/schema.json`;
}

export async function generateTemplate(): Promise<string> {
  const commit = await getLatestCommit();
  const schemaRef = await getSchemaReference();

  const template = `{
  // LLM Proxy Configuration
  // Schema: ${schemaRef}
  // Template Updated: ${commit.date}
  // Latest Commit: ${commit.sha}

  // JSON Schema reference
  "$schema": "${schemaRef}",

  // State adapter for caching
  // Options: "memory" (default) or "redis"
  // For Redis with custom URL: { "redis_url": "redis://..." }
  "state-adapter": "memory",

  // LLM Backend Configurations
  "models": {
    "openai": [
      {
        // Unique identifier for this backend instance
        "id": "primary-openai",
        // Display name for this backend
        "name": "Primary Instance",
        // Models this backend supports
        "models": [
          "gpt-3.5-turbo",
          "gpt-4",
          "gpt-4-turbo"
        ],
        // Track rate limits per backend instance
        "individualLimit": true,
        // Base URL for the OpenAI-compatible API
        "baseUrl": "https://api.openai.com/v1",
        // API key for authentication (use env var: \${OPENAI_API_KEY})
        "apiKey": "\${OPENAI_API_KEY}",
        // Rate limiting configuration
        "rateLimit": {
          // Tokens allowed per minute
          "tokensPerMinute": 90000,
          // Requests allowed per minute
          "requestsPerMinute": 3500,
          // Requests allowed per day
          "requestsPerDay": 200000
        }
      }
      // Add more backends as needed
    ]
  }

  // Optional: Proxy configuration (commented out by default)
  // "proxy": "http://user:pass@proxy.com:port"
}
`;

  return template;
}

export function getConfigFileName(): string {
  return 'model.jsonc';
}
