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
const LEVEL_ORDER = {
    debug: 10,
    info: 20,
    warning: 30,
    error: 40,
};
let _configured = false;
let _requestId = null;
let _minLevel = 'info';
let _logFilePath = null;
let _streamStderr = false;
const _loggers = new Map();
export function setRequestId(requestId) {
    _requestId = requestId;
}
export function getRequestId() {
    return _requestId;
}
function emit(name, level, msg, fields) {
    ensureDefaultSetup();
    if (LEVEL_ORDER[level] < LEVEL_ORDER[_minLevel]) {
        return;
    }
    const obj = {
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
        }
        catch {
            // best-effort: never let logging crash the CLI
        }
    }
    if (_streamStderr) {
        process.stderr.write(line + '\n');
    }
}
/** A structured logger bound to a component name. */
export class Logger {
    name;
    constructor(name) {
        this.name = name;
    }
    debug(msg, fields) {
        emit(this.name, 'debug', msg, fields);
    }
    info(msg, fields) {
        emit(this.name, 'info', msg, fields);
    }
    warning(msg, fields) {
        emit(this.name, 'warning', msg, fields);
    }
    warn(msg, fields) {
        emit(this.name, 'warning', msg, fields);
    }
    error(msg, fields) {
        emit(this.name, 'error', msg, fields);
    }
    /** Log an error with the exception attached (mirrors logging.exception). */
    exception(msg, err) {
        const fields = {};
        if (err instanceof Error) {
            fields.error = err.message;
            fields.stack = err.stack;
        }
        else if (err !== undefined) {
            fields.error = String(err);
        }
        emit(this.name, 'error', msg, fields);
    }
}
/**
 * Configure logging with explicit options. Runs at most once.
 */
export function setupLogging(opts = {}) {
    if (_configured) {
        return;
    }
    _minLevel = opts.level?.toLowerCase() || 'info';
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
function ensureDefaultSetup() {
    if (_configured) {
        return;
    }
    _minLevel = 'info';
    const logPath = join(homedir(), '.weather-agents', 'wa.log');
    try {
        mkdirSync(dirname(logPath), { recursive: true });
        openSync(logPath, 'a');
        _logFilePath = logPath;
    }
    catch {
        _logFilePath = null; // null sink — CLI never crashes on logging
    }
    if (process.env.WA_DEBUG === '1') {
        _streamStderr = true;
    }
    _configured = true;
}
/** Get a structured logger for the given component name. */
export function getLogger(name) {
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
export function logEvent(logger, eventType, fields) {
    logger.info(eventType, fields);
}
//# sourceMappingURL=logger.js.map