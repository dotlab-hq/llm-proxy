#!/usr/bin/env bun

import { 
  intro, 
  outro,
  confirm,
  text,
  isCancel,
  log,
  spinner
} from 'clack';
import path from 'path';
import { readConfig } from '../utils/readConfig';
import { CACHE } from '../state';
import { serve } from 'bun';
import app from '../server';

const cwd = process.cwd();
const modelFilePath = path.join(cwd, 'model.json');

interface CliOptions {
  skipPrompts?: boolean;
}

const getCliOptions = (): CliOptions => {
  const skipPrompts = process.argv.includes('--skip-prompts');
  return { skipPrompts };
};

const showError = (message: string) => {
  log.error(`❌ ${message}`);
};

const showSuccess = (message: string) => {
  log.success(`✅ ${message}`);
};

const INIT_TEMPLATE = {
  $schema: 'file:///schema.json',
  'state-adapter': 'memory',
  models: {
    openai: [
      {
        id: 'primary-openai',
        name: 'Primary Instance',
        models: ['gpt-3.5-turbo', 'gpt-4'],
        individualLimit: true,
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-your-api-key-here',
        rateLimit: {
          tokensPerMinute: 90000,
          requestsPerMinute: 3500,
          requestsPerDay: 200000,
        },
      },
    ],
  },
};

async function initCommand() {
  intro('🚀 Initializing LLM Proxy');

  const opts = getCliOptions();

  try {
    // Check if model.json already exists
    const modelFile = Bun.file(modelFilePath);
    if (await modelFile.exists()) {
      if (!opts.skipPrompts) {
        const shouldOverwrite = await confirm({
          message: 'model.json already exists. Overwrite?',
          initialValue: false,
        });

        if (isCancel(shouldOverwrite) || !shouldOverwrite) {
          outro('Cancelled initialization');
          process.exit(0);
        }
      }
    }

    const s = spinner();
    s.start('Creating model.json...');

    // Write template
    await Bun.write(
      modelFilePath,
      JSON.stringify(INIT_TEMPLATE, null, 2)
    );

    s.stop('✅ model.json created successfully');

    log.message('');
    log.message('📋 Configuration Instructions:');
    log.message('');
    log.message('1. Edit model.json in your project root');
    log.message('2. Update the following fields:');
    log.message('   - baseUrl: Your LLM provider base URL');
    log.message('   - apiKey: Your API key');
    log.message('   - models: Add your supported models');
    log.message('   - rateLimit: Configure rate limits as needed');
    log.message('');
    log.message('3. Set state-adapter:');
    log.message('   - "memory" for in-memory caching');
    log.message('   - "redis" for Redis caching');
    log.message('   - { redis_url: "redis://..." } for Redis with custom URL');
    log.message('');
    log.message('4. Once configured, run: llm-proxy start');
    log.message('');

    showSuccess('LLM Proxy initialized! Ready to configure.');
    outro('Run "llm-proxy start" to start the server');
  } catch (error: any) {
    showError(error.message || 'Failed to initialize LLM Proxy');
    process.exit(1);
  }
}

async function startCommand() {
  intro('🚀 Starting LLM Proxy Server');

  const opts = getCliOptions();

  try {
    // Check if model.json exists
    const modelFile = Bun.file(modelFilePath);
    if (!(await modelFile.exists())) {
      showError('model.json not found. Run "llm-proxy init" first.');
      process.exit(1);
    }

    const s = spinner();
    s.start('Loading configuration...');

    // Load config
    const configData = await readConfig(modelFilePath);
    
    s.stop('✅ Configuration loaded');

    // Auto-load stats/cache on startup
    const s2 = spinner();
    s2.start('Initializing cache and statistics...');

    try {
      const cacheData = await CACHE.getJson();
      s2.stop(`✅ Cache initialized with ${Object.keys(cacheData).length} entries`);
    } catch (err) {
      s2.stop('✅ Cache initialized (empty)');
    }

    log.message('');
    log.message('📊 Server Configuration:');
    log.message('');
    log.message(`State Adapter: ${configData['state-adapter']}`);
    log.message(`Models: ${configData.models.openai.length} configured`);
    log.message('');

    // Ask about proxy settings
    let proxyUrl = configData.proxy || '';
    let apiKeyDefault = 'nlm-proxy';
    
    if (!opts.skipPrompts && !proxyUrl) {
      const proxy = await text({
        message: 'Proxy URL (optional, leave empty to skip):',
        placeholder: 'http://user:pass@proxy.com:port',
        defaultValue: '',
      });

      if (!isCancel(proxy) && proxy) {
        proxyUrl = proxy;
      }
    }

    const apiKey = await text({
      message: 'API Key for this server (default: nlm-proxy):',
      placeholder: 'your-api-key',
      defaultValue: apiKeyDefault,
    });

    if (isCancel(apiKey)) {
      outro('Cancelled server start');
      process.exit(0);
    }

    const port = await text({
      message: 'Server port (default: 3000):',
      placeholder: '3000',
      defaultValue: '3000',
    });

    if (isCancel(port)) {
      outro('Cancelled server start');
      process.exit(0);
    }

    const portNum = parseInt(port as string) || 3000;

    log.message('');
    log.message('🌐 Server Details:');
    log.message('');
    log.message(`Base URL: http://localhost:${portNum}`);
    log.message(`API Key: ${apiKey}`);
    if (proxyUrl) {
      log.message(`Proxy: ${proxyUrl}`);
    }
    log.message('');
    log.message('Available endpoints:');
    log.message('  GET  / - Cache status');
    log.message('  GET  /stats - Rate limit statistics');
    log.message('  POST /v1/chat/completions - OpenAI compatible endpoint');
    log.message('');

    const s3 = spinner();
    s3.start('Starting server...');

    // Start the server
    const server = serve({
      fetch: app.fetch,
      port: portNum,
    });

    s3.stop(`✅ Server running on http://localhost:${portNum}`);

    log.message('');
    showSuccess('LLM Proxy is ready to use!');
    log.message('');
    log.message('📚 Usage:');
    log.message(`curl -X GET http://localhost:${portNum}/ \\`);
    log.message(`  -H "Authorization: Bearer ${apiKey}"`);
    log.message('');
    log.message('Press Ctrl+C to stop the server');
    log.message('');

  } catch (error: any) {
    showError(error.message || 'Failed to start server');
    process.exit(1);
  }
}

async function resetCommand() {
  intro('🔄 Resetting LLM Proxy Configuration');

  const opts = getCliOptions();

  try {
    let shouldReset = true;

    if (!opts.skipPrompts) {
      shouldReset = await confirm({
        message: 'Reset model.json to initial template?',
        initialValue: false,
      });

      if (isCancel(shouldReset)) {
        outro('Cancelled reset');
        process.exit(0);
      }
    }

    if (!shouldReset) {
      outro('Cancelled reset');
      process.exit(0);
    }

    const s = spinner();
    s.start('Resetting configuration...');

    // Clear cache if server is running
    try {
      await CACHE.clearCache();
    } catch (err) {
      // Cache might not be initialized yet
    }

    // Write template
    await Bun.write(
      modelFilePath,
      JSON.stringify(INIT_TEMPLATE, null, 2)
    );

    s.stop('✅ Configuration reset');

    log.message('');
    log.message('💡 Next steps:');
    log.message('1. Edit model.json with your configuration');
    log.message('2. Run: llm-proxy start');
    log.message('');

    showSuccess('LLM Proxy configuration has been reset.');
    outro('Ready for new configuration');
  } catch (error: any) {
    showError(error.message || 'Failed to reset configuration');
    process.exit(1);
  }
}

async function main() {
  const command = process.argv[2];

  switch (command) {
    case 'init':
      await initCommand();
      break;
    case 'start':
    case 'serve':
      await startCommand();
      break;
    case 'reset':
      await resetCommand();
      break;
    default:
      intro('🚀 LLM Proxy CLI');
      log.message('');
      log.message('Usage: llm-proxy <command>');
      log.message('');
      log.message('Commands:');
      log.message('  init      - Initialize model.json configuration');
      log.message('  start     - Start the LLM Proxy server');
      log.message('  reset     - Reset configuration to template');
      log.message('');
      log.message('Options:');
      log.message('  --skip-prompts  - Skip interactive prompts');
      log.message('');
      outro('For more info, visit: https://github.com/dotlabs-hq/llm-proxy');
  }
}

main().catch((err) => {
  showError(err.message || 'An unexpected error occurred');
  process.exit(1);
});
