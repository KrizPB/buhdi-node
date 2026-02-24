/**
 * Daemon mode — no TTY, file logging only, exception handlers
 */

import { getLogger, initLogger } from './logger';
import fs from 'fs';
import path from 'path';
import os from 'os';

const CRASH_LOG = path.join(os.homedir(), '.buhdi-node', 'crash.log');

function crashLog(msg: string): void {
  try {
    fs.appendFileSync(CRASH_LOG, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

export function setupDaemon(logLevel?: string): void {
  // Init logger in daemon mode (file-only)
  initLogger({ daemon: true, logLevel: logLevel || 'info' });
  const logger = getLogger();

  process.on('uncaughtException', (err) => {
    const msg = `Uncaught exception: ${err.message}\n${err.stack}`;
    logger.error(msg);
    crashLog(`UNCAUGHT: ${msg}`);
    // Don't exit — try to keep running unless truly fatal
    // process.exit(1); // REMOVED: was killing daemon on non-fatal errors
  });

  process.on('unhandledRejection', (reason) => {
    const msg = `Unhandled rejection: ${String(reason)}`;
    logger.error(msg);
    crashLog(`REJECT: ${msg}`);
  });

  process.on('exit', (code) => {
    crashLog(`EXIT code=${code}`);
    crashLog(`stack=${new Error().stack}`);
  });

  // Intercept process.exit to capture who's calling it
  const origExit = process.exit;
  (process as any).exit = function(code?: number) {
    crashLog(`process.exit(${code}) called from: ${new Error().stack}`);
    origExit.call(process, code);
  };

  logger.info('Daemon mode initialized');
}
