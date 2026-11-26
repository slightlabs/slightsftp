/**
 * Application log.
 *
 * Environment:
 *   LOG_LEVEL   error | warn | info (default) | http (adds web requests) | verbose | debug
 *   LOG_FORMAT  text (default) | json — one JSON object per line on stdout, for log
 *               collectors (Docker / Kubernetes logging drivers, Loki, ELK, ...)
 *   LOG_FILES   set to "false" to log to stdout only (containers); otherwise
 *               combined.log and error.log, rotated at 10 MB (5 kept), in the logs folder
 *
 * Messages logged while a web request is handled carry its requestId (also
 * returned in the X-Request-Id response header) — see requestContext.
 */
import { AsyncLocalStorage } from 'async_hooks';
import * as winston from 'winston';
import * as path from 'path';
import * as fs from 'fs';

/** Per-request context; logger output includes its requestId automatically. */
export const requestContext = new AsyncLocalStorage<{ requestId: string }>();

// Get logs directory based on environment
function getLogsDirectory(): string {
  // Try to use Electron's app if available, otherwise fall back to Node.js
  try {
    const { app } = require('electron');
    const isPackaged = app.isPackaged;

    if (isPackaged) {
      // Production: same base folder as the app's config (see getAppDirectories in main.ts)
      const base = process.platform === 'win32' ? path.dirname(app.getPath('exe')) : app.getPath('userData');
      return path.join(base, 'logs');
    } else {
      // Development: Use current working directory
      return path.join(process.cwd(), 'logs');
    }
  } catch (error) {
    // Not running in Electron, use current working directory
    return path.join(process.cwd(), 'logs');
  }
}

const json = (process.env.LOG_FORMAT || '').toLowerCase() === 'json';
const toFiles = (process.env.LOG_FILES || '').toLowerCase() !== 'false';

/** Adds the current request's id, if any. */
const withRequestId = winston.format(info => {
  const ctx = requestContext.getStore();
  if (ctx && info.requestId === undefined) info.requestId = ctx.requestId;
  return info;
});

/** "msg", meta... → message plus a JSON tail; errors with their stack. */
function textLine(info: winston.Logform.TransformableInfo, upper: boolean): string {
  const { timestamp, level, message, stack, ...meta } = info as any;
  let line = `${timestamp} [${upper ? String(level).toUpperCase() : level}]: ${message}`;
  // winston keeps splat arguments under a symbol; plain meta keys are enumerable
  if (Object.keys(meta).length > 0) line += ` ${JSON.stringify(meta)}`;
  if (stack) line += `\n${stack}`;
  return line;
}

const consoleFormat = json
  ? winston.format.combine(
      winston.format.errors({ stack: true }),
      winston.format.timestamp(), // ISO 8601, UTC
      withRequestId(),
      winston.format.json(),
    )
  : winston.format.combine(
      winston.format.errors({ stack: true }),
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      withRequestId(),
      // colours only for a terminal: not in docker logs, journald or files
      ...(process.stdout.isTTY ? [winston.format.colorize()] : []),
      winston.format.printf(info => textLine(info, false)),
    );

const fileFormat = winston.format.combine(
  winston.format.errors({ stack: true }),
  winston.format.timestamp({ format: () => new Date().toISOString() }),
  withRequestId(),
  winston.format.printf(info => textLine(info, true)),
);

const transports: winston.transport[] = [new winston.transports.Console({ format: consoleFormat })];

if (toFiles) {
  const logsDir = getLogsDirectory();
  fs.mkdirSync(logsDir, { recursive: true });
  transports.push(
    // everything, rotated by size
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      format: fileFormat,
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
    }),
    // errors only
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      format: fileFormat,
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
    }),
  );
}

// Uncaught exceptions and unhandled rejections are handled by the entry points
// (lifecycle.ts for the headless server, main.ts for the desktop app). Winston's
// own handlers would exit the process immediately (exitOnError), skipping the
// graceful shutdown, and would close the desktop app on any stray error.
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  transports,
});

export default logger;
