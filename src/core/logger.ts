/**
 * Structured logging for Weather Agents.
 *
 * Usage:
 *   import { getLogger } from './logger.js';
 *   const log = getLogger('fog');
 *   log.info('chat_request', { user_message: 'hello', agent: 'fog' });
 *
 * Mirrors the Python logging setup: file-only by default (so warnings don't
 * pollute the CLI UI), with opt-in stderr streaming via WA_DEBUG=1.
 */

import { appendFileSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warning' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warning: 30,
  error: 40,
};

let _configured = false;
let _requestId: string | null = null;
let _minLevel: LogLevel = 'info';
let _logFilePath: string | null = null;
let _streamStderr = false;
const _loggers = new Map<string, Logger>();

export function setRequestId(requestId: string | null): void {
  _requestId = requestId;
}

export function getRequestId(): string | null {
  return _requestId;
}

function emit(name: string, level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
  ensureDefaultSetup();
  if (LEVEL_ORDER[level] < LEVEL_ORDER[_minLevel]) {
    return;
  }
  const obj: Record<string, unknown> = {
    ts: new Date().toISOString(),
    level,
    logger: `wa.${name}`,
    msg,
  };
  if (_requestId) {
    obj.request_id = _requestId;
  }
  if (fields) {
    Object.assign(obj, fields);
  }
  const line = JSON.stringify(obj);

  if (_logFilePath) {
    try {
      appendFileSync(_logFilePath, line + '\n', { encoding: 'utf-8' });
    } catch {
      // best-effort: never let logging crash the CLI
    }
  }
  if (_streamStderr) {
    process.stderr.write(line + '\n');
  }
}

/** A structured logger bound to a component name. */
export class Logger {
  constructor(private readonly name: string) {}

  debug(msg: string, fields?: Record<string, unknown>): void {
    emit(this.name, 'debug', msg, fields);
  }

  info(msg: string, fields?: Record<string, unknown>): void {
    emit(this.name, 'info', msg, fields);
  }

  warning(msg: string, fields?: Record<string, unknown>): void {
    emit(this.name, 'warning', msg, fields);
  }

  warn(msg: string, fields?: Record<string, unknown>): void {
    emit(this.name, 'warning', msg, fields);
  }

  error(msg: string, fields?: Record<string, unknown>): void {
    emit(this.name, 'error', msg, fields);
  }

  /** Log an error with the exception attached (mirrors logging.exception). */
  exception(msg: string, err?: unknown): void {
    const fields: Record<string, unknown> = {};
    if (err instanceof Error) {
      fields.error = err.message;
      fields.stack = err.stack;
    } else if (err !== undefined) {
      fields.error = String(err);
    }
    emit(this.name, 'error', msg, fields);
  }
}

/**
 * Configure logging with explicit options. Runs at most once.
 */
export function setupLogging(
  opts: { level?: string; logFile?: string | null; jsonOutput?: boolean } = {},
): void {
  if (_configured) {
    return;
  }
  _minLevel = (opts.level?.toLowerCase() as LogLevel) || 'info';
  if (!(_minLevel in LEVEL_ORDER)) {
    _minLevel = 'info';
  }
  _streamStderr = true;
  if (opts.logFile) {
    const p = opts.logFile;
    mkdirSync(dirname(p), { recursive: true });
    openSync(p, 'a');
    _logFilePath = p;
  }
  _configured = true;
}

/**
 * Configure default file-only logging so warnings don't pollute the CLI UI.
 * Runs at most once. If WA_DEBUG=1 is set, also stream to stderr.
 */
function ensureDefaultSetup(): void {
  if (_configured) {
    return;
  }
  _minLevel = 'info';
  const logPath = join(homedir(), '.weather-agents', 'wa.log');
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    openSync(logPath, 'a');
    _logFilePath = logPath;
  } catch {
    _logFilePath = null; // null sink — CLI never crashes on logging
  }
  if (process.env.WA_DEBUG === '1') {
    _streamStderr = true;
  }
  _configured = true;
}

/** Get a structured logger for the given component name. */
export function getLogger(name: string): Logger {
  ensureDefaultSetup();
  let logger = _loggers.get(name);
  if (logger === undefined) {
    logger = new Logger(name);
    _loggers.set(name, logger);
  }
  return logger;
}

/**
 * Log a structured event with extra fields.
 *
 * Usage: logEvent(log, 'tool_call', { tool: 'read_file', duration_ms: 42 });
 */
export function logEvent(logger: Logger, eventType: string, fields: Record<string, unknown>): void {
  logger.info(eventType, fields);
}
