/**
 * Main bootstrap: load config, init logger, start MCP server, wire SIGTERM/SIGINT.
 */

import { loadEnvironmentConfig } from './utils/config.js';
import { Logger } from './utils/logger.js';
import { SalesforceMcpServer } from './mcp/server.js';

async function main(): Promise<void> {
  const envConfig = loadEnvironmentConfig();
  const logger = new Logger(envConfig.logging.level, envConfig.transport.type === 'stdio');

  logger.info('Starting salesforce-mcp', {
    transport: envConfig.transport.type,
    port: envConfig.transport.port,
    authMode: envConfig.authMode,
    build: envConfig.build,
  });

  const server = new SalesforceMcpServer(envConfig, logger);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down gracefully`);
    try {
      await server.stop();
    } catch (err) {
      logger.error('Error during shutdown', { err: err instanceof Error ? err.message : String(err) });
    }
    process.exit(0);
  };

  process.on('SIGINT', () => {
    shutdown('SIGINT').catch(() => process.exit(1));
  });
  process.on('SIGTERM', () => {
    shutdown('SIGTERM').catch(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', {
      err: reason instanceof Error ? reason.message : String(reason),
    });
  });
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { err: err.message });
    process.exit(1);
  });

  await server.start();
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Fatal error in salesforce-mcp main():', err);
  process.exit(1);
});
