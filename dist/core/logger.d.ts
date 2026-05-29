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
export type LogLevel = 'debug' | 'info' | 'warning' | 'error';
export declare function setRequestId(requestId: string | null): void;
export declare function getRequestId(): string | null;
/** A structured logger bound to a component name. */
export declare class Logger {
    private readonly name;
    constructor(name: string);
    debug(msg: string, fields?: Record<string, unknown>): void;
    info(msg: string, fields?: Record<string, unknown>): void;
    warning(msg: string, fields?: Record<string, unknown>): void;
    warn(msg: string, fields?: Record<string, unknown>): void;
    error(msg: string, fields?: Record<string, unknown>): void;
    /** Log an error with the exception attached (mirrors logging.exception). */
    exception(msg: string, err?: unknown): void;
}
/**
 * Configure logging with explicit options. Runs at most once.
 */
export declare function setupLogging(opts?: {
    level?: string;
    logFile?: string | null;
    jsonOutput?: boolean;
}): void;
/** Get a structured logger for the given component name. */
export declare function getLogger(name: string): Logger;
/**
 * Log a structured event with extra fields.
 *
 * Usage: logEvent(log, 'tool_call', { tool: 'read_file', duration_ms: 42 });
 */
export declare function logEvent(logger: Logger, eventType: string, fields: Record<string, unknown>): void;
