/**
 * Daemon mode — no TTY, file logging only, exception handlers
 */

import { getLogger, initLogger } from './logger';

export function setupDaemon(logLevel?: string): void {
  // Init logger in daemon mode (file-only)
  initLogger({ daemon: true, logLevel: logLevel || 'info' });
  const logger = getLogger();

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception — exiting for service restart', {
      error: err.message,
      stack: err.stack,
    });
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    logger.warn('Unhandled rejection — continuing', {
      reason: String(reason),
    });
  });

  logger.info('Daemon mode initialized');
}
