/**
 * Winston-based structured logging for buhdi-node
 */

import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import path from 'path';
import os from 'os';
import fs from 'fs';

const LOG_DIR = path.join(os.homedir(), '.buhdi-node', 'logs');

let _logger: winston.Logger | null = null;
let _isDaemon = false;

export function initLogger(opts: { daemon?: boolean; logLevel?: string } = {}): winston.Logger {
  _isDaemon = !!opts.daemon;
  const level = opts.logLevel || 'info';

  // Ensure log directory exists
  fs.mkdirSync(LOG_DIR, { recursive: true });

  const fileTransport = new DailyRotateFile({
    dirname: LOG_DIR,
    filename: 'buhdi-node-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    maxSize: '10m',
    maxFiles: '7d',
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json()
    ),
  });

  const transports: winston.transport[] = [fileTransport];

  if (!_isDaemon) {
    transports.push(new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.printf(({ level, message, timestamp, ...meta }) => {
          const metaStr = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
          return `${message}${metaStr}`;
        })
      ),
    }));
  }

  _logger = winston.createLogger({
    level,
    transports,
  });

  return _logger;
}

export function getLogger(): winston.Logger {
  if (!_logger) {
    return initLogger();
  }
  return _logger;
}

export function isDaemonMode(): boolean {
  return _isDaemon;
}
