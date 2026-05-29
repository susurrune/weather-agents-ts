/**
 * Middleware/interceptor chain for tool execution.
 *
 * Provides ACL (access control), rate limiting, and audit logging
 * as composable hooks around Tool.execute().
 */

import { type Event, EventType, type MessageBus, makeEvent } from './bus.js';
import { getLogger } from './logger.js';

const log = getLogger('middleware');

/** Pre-hook result: [allowed, reason]. reason is null when allowed. */
export type PreResult = [boolean, string | null];

/** Middleware that wraps tool execution. */
export interface Middleware {
  /** Called before tool execution. Return [true, null] to allow, [false, reason] to deny. */
  pre(
    toolName: string,
    agentName: string | null,
    kwargs: Record<string, unknown>,
  ): Promise<PreResult>;

  /** Called after tool execution (success or failure). */
  post(
    toolName: string,
    agentName: string | null,
    kwargs: Record<string, unknown>,
    result: string,
    success: boolean,
    durationMs: number,
  ): Promise<void>;
}

/** Wall-clock monotonic seconds (mirrors Python time.monotonic). */
function monotonic(): number {
  return performance.now() / 1000;
}

interface ACLRule {
  allowedTools: Set<string>;
  deniedTools: Set<string>;
}

/**
 * Access-control list middleware.
 *
 * Controls which agents can call which tools. When `allowByDefault` is true
 * (default), only explicitly denied tools are blocked; when false, only
 * explicitly allowed tools are permitted.
 */
export class ACLMiddleware implements Middleware {
  private readonly rules = new Map<string, ACLRule>();

  constructor(public allowByDefault = true) {}

  private ruleFor(agentName: string): ACLRule {
    let rule = this.rules.get(agentName);
    if (!rule) {
      rule = { allowedTools: new Set(), deniedTools: new Set() };
      this.rules.set(agentName, rule);
    }
    return rule;
  }

  /** Explicitly allow `agentName` to call `toolNames`. */
  allow(agentName: string, ...toolNames: string[]): void {
    const rule = this.ruleFor(agentName);
    for (const t of toolNames) {
      rule.allowedTools.add(t);
      rule.deniedTools.delete(t);
    }
  }

  /** Explicitly deny `agentName` from calling `toolNames`. */
  deny(agentName: string, ...toolNames: string[]): void {
    const rule = this.ruleFor(agentName);
    for (const t of toolNames) {
      rule.deniedTools.add(t);
      rule.allowedTools.delete(t);
    }
  }

  removeRules(agentName: string): void {
    this.rules.delete(agentName);
  }

  async pre(toolName: string, agentName: string | null): Promise<PreResult> {
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

  async post(): Promise<void> {
    // no-op
  }
}

/**
 * Sliding-window rate limiter per tool.
 *
 * Limits the number of calls to each tool within a rolling time window.
 * Per-tool overrides can be set via `setLimit()`.
 */
export class RateLimitMiddleware implements Middleware {
  private readonly calls = new Map<string, number[]>();
  private readonly overrides = new Map<string, [number, number]>();

  constructor(
    public defaultMaxCalls = 30,
    public defaultWindow = 60.0,
  ) {}

  setLimit(toolName: string, maxCalls: number, windowSeconds: number): void {
    this.overrides.set(toolName, [maxCalls, windowSeconds]);
  }

  clear(): void {
    this.calls.clear();
    this.overrides.clear();
  }

  async pre(toolName: string): Promise<PreResult> {
    const [maxCalls, window] = this.overrides.get(toolName) ?? [
      this.defaultMaxCalls,
      this.defaultWindow,
    ];

    const now = monotonic();
    const cutoff = now - window;

    const calls = (this.calls.get(toolName) ?? []).filter((t) => t > cutoff);
    if (calls.length) {
      this.calls.set(toolName, calls);
    } else {
      this.calls.delete(toolName); // prevent unbounded key growth
    }

    if (calls.length >= maxCalls) {
      const remaining = calls.length ? Math.trunc(calls[0]! + window - now) : 0;
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

  async post(): Promise<void> {
    // no-op
  }
}

/**
 * Audit-logging middleware.
 *
 * Publishes tool-call events to the message bus with timing, agent identity,
 * success/failure, and truncated result preview. Internal observability only.
 */
export class AuditMiddleware implements Middleware {
  constructor(private readonly bus: MessageBus | null = null) {}

  async pre(): Promise<PreResult> {
    return [true, null];
  }

  async post(
    toolName: string,
    agentName: string | null,
    kwargs: Record<string, unknown>,
    result: string,
    success: boolean,
    durationMs: number,
  ): Promise<void> {
    if (this.bus === null) {
      return;
    }
    const safeArgs: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(kwargs)) {
      safeArgs[k] = typeof v === 'number' || typeof v === 'boolean' ? v : String(v).slice(0, 200);
    }
    const safeResult = (result || '').slice(0, 500);

    try {
      const event: Event = makeEvent(EventType.TOOL_CALL, agentName || 'unknown', {
        data: {
          tool: toolName,
          args: safeArgs,
          success,
          duration_ms: Math.round(durationMs * 10) / 10,
          result_preview: safeResult,
        },
      });
      this.bus.addEvent(event);
    } catch (exc) {
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
  private readonly middleware: Middleware[] = [];

  add(middleware: Middleware): void {
    this.middleware.push(middleware);
  }

  async runPre(
    toolName: string,
    agentName: string | null,
    kwargs: Record<string, unknown>,
  ): Promise<PreResult> {
    for (const mw of this.middleware) {
      const [allowed, reason] = await mw.pre(toolName, agentName, kwargs);
      if (!allowed) {
        return [false, reason];
      }
    }
    return [true, null];
  }

  async runPost(
    toolName: string,
    agentName: string | null,
    kwargs: Record<string, unknown>,
    result: string,
    success: boolean,
    durationMs: number,
  ): Promise<void> {
    for (const mw of this.middleware) {
      try {
        await mw.post(toolName, agentName, kwargs, result, success, durationMs);
      } catch (exc) {
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

let _globalChain: MiddlewareChain | null = null;

/** Set the global middleware chain used by Tool.execute(). */
export function setMiddlewareChain(chain: MiddlewareChain | null): void {
  _globalChain = chain;
}

/** Return the global middleware chain, or null. */
export function getMiddlewareChain(): MiddlewareChain | null {
  return _globalChain;
}
