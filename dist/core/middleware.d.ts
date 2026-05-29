/**
 * Middleware/interceptor chain for tool execution.
 *
 * Provides ACL (access control), rate limiting, and audit logging
 * as composable hooks around Tool.execute().
 */
import { type MessageBus } from './bus.js';
/** Pre-hook result: [allowed, reason]. reason is null when allowed. */
export type PreResult = [boolean, string | null];
/** Middleware that wraps tool execution. */
export interface Middleware {
    /** Called before tool execution. Return [true, null] to allow, [false, reason] to deny. */
    pre(toolName: string, agentName: string | null, kwargs: Record<string, unknown>): Promise<PreResult>;
    /** Called after tool execution (success or failure). */
    post(toolName: string, agentName: string | null, kwargs: Record<string, unknown>, result: string, success: boolean, durationMs: number): Promise<void>;
}
/**
 * Access-control list middleware.
 *
 * Controls which agents can call which tools. When `allowByDefault` is true
 * (default), only explicitly denied tools are blocked; when false, only
 * explicitly allowed tools are permitted.
 */
export declare class ACLMiddleware implements Middleware {
    allowByDefault: boolean;
    private readonly rules;
    constructor(allowByDefault?: boolean);
    private ruleFor;
    /** Explicitly allow `agentName` to call `toolNames`. */
    allow(agentName: string, ...toolNames: string[]): void;
    /** Explicitly deny `agentName` from calling `toolNames`. */
    deny(agentName: string, ...toolNames: string[]): void;
    removeRules(agentName: string): void;
    pre(toolName: string, agentName: string | null): Promise<PreResult>;
    post(): Promise<void>;
}
/**
 * Sliding-window rate limiter per tool.
 *
 * Limits the number of calls to each tool within a rolling time window.
 * Per-tool overrides can be set via `setLimit()`.
 */
export declare class RateLimitMiddleware implements Middleware {
    defaultMaxCalls: number;
    defaultWindow: number;
    private readonly calls;
    private readonly overrides;
    constructor(defaultMaxCalls?: number, defaultWindow?: number);
    setLimit(toolName: string, maxCalls: number, windowSeconds: number): void;
    clear(): void;
    pre(toolName: string): Promise<PreResult>;
    post(): Promise<void>;
}
/**
 * Audit-logging middleware.
 *
 * Publishes tool-call events to the message bus with timing, agent identity,
 * success/failure, and truncated result preview. Internal observability only.
 */
export declare class AuditMiddleware implements Middleware {
    private readonly bus;
    constructor(bus?: MessageBus | null);
    pre(): Promise<PreResult>;
    post(toolName: string, agentName: string | null, kwargs: Record<string, unknown>, result: string, success: boolean, durationMs: number): Promise<void>;
}
/**
 * Chain of middleware hooks applied around tool execution.
 *
 * Pre-hooks run in registration order; if any returns [false, reason] the
 * chain short-circuits and the tool is denied. Post-hooks always run.
 */
export declare class MiddlewareChain {
    private readonly middleware;
    add(middleware: Middleware): void;
    runPre(toolName: string, agentName: string | null, kwargs: Record<string, unknown>): Promise<PreResult>;
    runPost(toolName: string, agentName: string | null, kwargs: Record<string, unknown>, result: string, success: boolean, durationMs: number): Promise<void>;
}
/** Set the global middleware chain used by Tool.execute(). */
export declare function setMiddlewareChain(chain: MiddlewareChain | null): void;
/** Return the global middleware chain, or null. */
export declare function getMiddlewareChain(): MiddlewareChain | null;
