/**
 * Middleware/interceptor chain for tool execution.
 *
 * Provides ACL (access control), rate limiting, and audit logging
 * as composable hooks around Tool.execute().
 */
import { EventType, makeEvent } from './bus.js';
import { getLogger } from './logger.js';
const log = getLogger('middleware');
/** Wall-clock monotonic seconds (mirrors Python time.monotonic). */
function monotonic() {
    return performance.now() / 1000;
}
/**
 * Access-control list middleware.
 *
 * Controls which agents can call which tools. When `allowByDefault` is true
 * (default), only explicitly denied tools are blocked; when false, only
 * explicitly allowed tools are permitted.
 */
export class ACLMiddleware {
    allowByDefault;
    rules = new Map();
    constructor(allowByDefault = true) {
        this.allowByDefault = allowByDefault;
    }
    ruleFor(agentName) {
        let rule = this.rules.get(agentName);
        if (!rule) {
            rule = { allowedTools: new Set(), deniedTools: new Set() };
            this.rules.set(agentName, rule);
        }
        return rule;
    }
    /** Explicitly allow `agentName` to call `toolNames`. */
    allow(agentName, ...toolNames) {
        const rule = this.ruleFor(agentName);
        for (const t of toolNames) {
            rule.allowedTools.add(t);
            rule.deniedTools.delete(t);
        }
    }
    /** Explicitly deny `agentName` from calling `toolNames`. */
    deny(agentName, ...toolNames) {
        const rule = this.ruleFor(agentName);
        for (const t of toolNames) {
            rule.deniedTools.add(t);
            rule.allowedTools.delete(t);
        }
    }
    removeRules(agentName) {
        this.rules.delete(agentName);
    }
    async pre(toolName, agentName) {
        if (agentName === null) {
            return this.allowByDefault ? [true, null] : [false, 'agent_name is required'];
        }
        const rule = this.rules.get(agentName);
        if (!rule) {
            return this.allowByDefault ? [true, null] : [false, `agent '${agentName}' has no ACL rules`];
        }
        if (rule.deniedTools.has(toolName)) {
            return [false, `agent '${agentName}' is not allowed to call '${toolName}'`];
        }
        if (!this.allowByDefault && !rule.allowedTools.has(toolName)) {
            return [false, `agent '${agentName}' is not allowed to call '${toolName}'`];
        }
        return [true, null];
    }
    async post() {
        // no-op
    }
}
/**
 * Sliding-window rate limiter per tool.
 *
 * Limits the number of calls to each tool within a rolling time window.
 * Per-tool overrides can be set via `setLimit()`.
 */
export class RateLimitMiddleware {
    defaultMaxCalls;
    defaultWindow;
    calls = new Map();
    overrides = new Map();
    constructor(defaultMaxCalls = 30, defaultWindow = 60.0) {
        this.defaultMaxCalls = defaultMaxCalls;
        this.defaultWindow = defaultWindow;
    }
    setLimit(toolName, maxCalls, windowSeconds) {
        this.overrides.set(toolName, [maxCalls, windowSeconds]);
    }
    clear() {
        this.calls.clear();
        this.overrides.clear();
    }
    async pre(toolName) {
        const [maxCalls, window] = this.overrides.get(toolName) ?? [
            this.defaultMaxCalls,
            this.defaultWindow,
        ];
        const now = monotonic();
        const cutoff = now - window;
        const calls = (this.calls.get(toolName) ?? []).filter((t) => t > cutoff);
        if (calls.length) {
            this.calls.set(toolName, calls);
        }
        else {
            this.calls.delete(toolName); // prevent unbounded key growth
        }
        if (calls.length >= maxCalls) {
            const remaining = calls.length ? Math.trunc(calls[0] + window - now) : 0;
            return [
                false,
                `rate limit exceeded for '${toolName}': ${maxCalls} calls per ${window}s window (retry in ~${remaining}s)`,
            ];
        }
        const bucket = this.calls.get(toolName) ?? [];
        bucket.push(now);
        this.calls.set(toolName, bucket);
        return [true, null];
    }
    async post() {
        // no-op
    }
}
/**
 * Audit-logging middleware.
 *
 * Publishes tool-call events to the message bus with timing, agent identity,
 * success/failure, and truncated result preview. Internal observability only.
 */
export class AuditMiddleware {
    bus;
    constructor(bus = null) {
        this.bus = bus;
    }
    async pre() {
        return [true, null];
    }
    async post(toolName, agentName, kwargs, result, success, durationMs) {
        if (this.bus === null) {
            return;
        }
        const safeArgs = {};
        for (const [k, v] of Object.entries(kwargs)) {
            safeArgs[k] = typeof v === 'number' || typeof v === 'boolean' ? v : String(v).slice(0, 200);
        }
        const safeResult = (result || '').slice(0, 500);
        try {
            const event = makeEvent(EventType.TOOL_CALL, agentName || 'unknown', {
                data: {
                    tool: toolName,
                    args: safeArgs,
                    success,
                    duration_ms: Math.round(durationMs * 10) / 10,
                    result_preview: safeResult,
                },
            });
            this.bus.addEvent(event);
        }
        catch (exc) {
            log.warning('audit_log_failed', { tool: toolName, error: String(exc) });
        }
    }
}
/**
 * Chain of middleware hooks applied around tool execution.
 *
 * Pre-hooks run in registration order; if any returns [false, reason] the
 * chain short-circuits and the tool is denied. Post-hooks always run.
 */
export class MiddlewareChain {
    middleware = [];
    add(middleware) {
        this.middleware.push(middleware);
    }
    async runPre(toolName, agentName, kwargs) {
        for (const mw of this.middleware) {
            const [allowed, reason] = await mw.pre(toolName, agentName, kwargs);
            if (!allowed) {
                return [false, reason];
            }
        }
        return [true, null];
    }
    async runPost(toolName, agentName, kwargs, result, success, durationMs) {
        for (const mw of this.middleware) {
            try {
                await mw.post(toolName, agentName, kwargs, result, success, durationMs);
            }
            catch (exc) {
                log.warning('middleware_post_failed', {
                    middleware: mw.constructor.name,
                    tool: toolName,
                    error: String(exc),
                });
            }
        }
    }
}
// ── Global active chain ────────────────────────────────────────────────────
let _globalChain = null;
/** Set the global middleware chain used by Tool.execute(). */
export function setMiddlewareChain(chain) {
    _globalChain = chain;
}
/** Return the global middleware chain, or null. */
export function getMiddlewareChain() {
    return _globalChain;
}
