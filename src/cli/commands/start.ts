import * as p from '@clack/prompts';
import chalk from 'chalk';
import path from 'path';
import net from 'node:net';
import { access } from 'node:fs/promises';
import { serve } from '@hono/node-server';
import { readConfig } from '../../utils/readConfig';
import { getConfigFileName } from '../utils/template';

const DEFAULT_PORT = 25789;

async function isPortAvailable( port: number ): Promise<boolean> {
    return new Promise( ( resolve ) => {
        const server = net.createServer();
        server.once( 'error', () => resolve( false ) );
        server.once( 'listening', () => {
            server.close( () => resolve( true ) );
        } );
        server.listen( port );
    } );
}

async function findAvailablePort( startPort: number ): Promise<number> {
    if ( await isPortAvailable( startPort ) ) {
        return startPort;
    }
    for ( let port = startPort + 1; port < 65535; port++ ) {
        if ( await isPortAvailable( port ) ) {
            return port;
        }
    }
    return startPort;
}

export async function startCommand(): Promise<void> {
  p.intro( chalk.blue( '🚀 Starting LLM Proxy Server' ) );
  p.note(
    `Built for development. Not to be used for production`
  );

  try {
    const cwd = process.cwd();
    const configFileName = getConfigFileName();
    const configPath = path.join( cwd, configFileName );

    const configExists = await access( configPath ).then( () => true ).catch( () => false );
    if ( !configExists ) {
      p.outro( chalk.red( `❌ ${configFileName} not found. Run "llm-proxy init" first.` ) );
      process.exit( 1 );
    }

    const s = p.spinner();
    s.start( 'Loading configuration...' );

    let configData;
    try {
      configData = await readConfig( configPath );
    } catch ( err: any ) {
      s.stop( '❌' );
      p.outro( chalk.red( `❌ ${err.message || 'Invalid configuration'}` ) );
      process.exit( 1 );
    }

    s.stop( '✅ Configuration loaded' );

    const skipPrompts = process.argv.includes( '--skip-prompts' );
    let portNum: number;

    if ( skipPrompts ) {
      portNum = await findAvailablePort( DEFAULT_PORT );
    } else {
      const suggestedPort = await findAvailablePort( DEFAULT_PORT );
      const port = await p.text( {
        message: 'Server port:',
        defaultValue: String( suggestedPort ),
        validate: ( v ) => {
          if ( v === undefined || v === '' ) return 'Port is required';
          const num = parseInt( v );
          return isNaN( num ) || num < 1 || num > 65535 ? 'Must be a valid port number' : undefined;
        },
      } );

      if ( p.isCancel( port ) ) {
        p.outro( chalk.gray( 'Cancelled' ) );
        process.exit( 0 );
      }

      portNum = parseInt( port! );
    }

    p.note(
      `Base URL: http://localhost:${portNum}\n` +
      `API Key: llm-proxy [anything will work :) ]\n` +
      `State Adapter: ${( configData as any )['state-adapter']}\n` +
      `Models Configured: ${( configData as any ).models.openai.length}`,
      '🌐 Server Configuration'
    );

    const s2 = p.spinner();
    s2.start( 'Starting server...' );

    try {
      const { default: app } = await import( '../../server' );

      serve( { fetch: app.fetch, port: portNum } );

      s2.stop( `✅ Server running on http://localhost:${portNum}` );

      p.note(
        `curl -X GET http://localhost:${portNum}/ \\\n` +
        `  -H "Authorization: Bearer nlm-proxy"`,
        '📚 Example Usage'
      );

      p.outro( chalk.green( '✅ LLM Proxy ready! Press Ctrl+C to stop' ) );

      // Graceful shutdown on Ctrl+C
      process.on( 'SIGINT', async () => {
        console.log( '\n' );
        p.outro( chalk.yellow( '👋 Shutting down server...' ) );
        process.exit( 0 );
      } );
    } catch ( err: any ) {
      s2.stop( '❌' );
      p.outro( chalk.red( `❌ ${err.message || 'Server startup failed'}` ) );
      process.exit( 1 );
    }
  } catch ( error: any ) {
    p.outro( chalk.red( `❌ ${error.message || 'Failed to start server'}` ) );
    process.exit( 1 );
  }
}
