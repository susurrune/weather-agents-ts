/** Tool registration and execution framework with retry support. */

import { getBreaker } from './circuitBreaker.js';
import { getLogger } from './logger.js';
import { getMiddlewareChain, type MiddlewareChain } from './middleware.js';
import { sleep, stableStringify } from './util.js';

const log = getLogger('tool');

const CACHE_MAXSIZE = 128;

/** Tool handler: receives the call args as an object, returns a string result. */
export type ToolHandler = (args: Record<string, any>) => Promise<string>;

/**
 * Build a deterministic cache key from tool kwargs.
 * Uses sorted-key JSON so dict/list values encode consistently across calls.
 */
function makeCacheKey(kwargs: Record<string, unknown>): string {
  return stableStringify(kwargs);
}

/**
 * Process-wide tool result cache. Survives tool unregister/reregister
 * (skill activation cycles, MCP reconnects). Bounded by CACHE_MAXSIZE
 * entries per tool name (LRU via Map insertion order).
 */
class ToolResultStore {
  private readonly store = new Map<string, Map<string, string>>();

  get(toolName: string, key: string): string | null {
    const bucket = this.store.get(toolName);
    if (!bucket) return null;
    const value = bucket.get(key);
    if (value !== undefined) {
      // move-to-end (most recently used)
      bucket.delete(key);
      bucket.set(key, value);
      return value;
    }
    return null;
  }

  set(toolName: string, key: string, value: string): void {
    let bucket = this.store.get(toolName);
    if (!bucket) {
      bucket = new Map();
      this.store.set(toolName, bucket);
    }
    bucket.delete(key);
    bucket.set(key, value);
    while (bucket.size > CACHE_MAXSIZE) {
      const oldest = bucket.keys().next().value;
      if (oldest === undefined) break;
      bucket.delete(oldest);
    }
  }

  clear(toolName?: string): void {
    if (toolName === undefined) {
      this.store.clear();
    } else {
      this.store.delete(toolName);
    }
  }
}

/** Exported so tests can isolate state between cases (mirrors _RESULT_STORE). */
export const RESULT_STORE = new ToolResultStore();

/**
 * Lenient JSON-schema-like type check. Values from LLM tool calls often
 * arrive as strings even for declared "number"/"boolean" — we accept those
 * common coercion cases instead of rejecting precise but inconvenient inputs.
 */
function valueMatchesSchemaType(value: unknown, schemaType: string): boolean {
  switch (schemaType) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      if (typeof value === 'number') return Number.isFinite(value);
      if (typeof value === 'string') return value.trim() !== '' && Number.isFinite(Number(value));
      return false;
    case 'integer':
      if (typeof value === 'number') return Number.isInteger(value);
      if (typeof value === 'string') {
        const n = Number(value);
        return value.trim() !== '' && Number.isInteger(n);
      }
      return false;
    case 'boolean':
      if (typeof value === 'boolean') return true;
      if (typeof value === 'string') return ['true', 'false'].includes(value.toLowerCase());
      return false;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    default:
      return true; // unknown declared type — don't reject
  }
}

export interface ToolParameter {
  name: string;
  type: string; // "string" | "number" | "boolean" | "array" | "object" | "integer"
  description: string;
  required?: boolean;
  default?: unknown;
}

export interface ToolInit {
  name: string;
  description: string;
  parameters?: ToolParameter[];
  handler?: ToolHandler | null;
  maxRetries?: number;
  retryDelay?: number;
  dangerous?: boolean;
  cacheable?: boolean;
  cacheKeyExtra?: ((kwargs: Record<string, unknown>) => string) | null;
}

/** OpenAI-style function-calling schema. */
export interface FunctionSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, Record<string, unknown>>;
      required: string[];
    };
  };
}

export class Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: ToolParameter[];
  readonly handler: ToolHandler | null;
  readonly maxRetries: number;
  readonly retryDelay: number;
  readonly dangerous: boolean;
  readonly cacheable: boolean;
  /**
   * Optional callback that adds an extra string into the cache key based on
   * the call's kwargs. read_file uses this to mix in the file's mtime so a
   * cached result is invalidated whenever the source file changes on disk.
   */
  readonly cacheKeyExtra: ((kwargs: Record<string, unknown>) => string) | null;

  // Built once and reused; tool fields are immutable after construction.
  private _schema: FunctionSchema | null = null;

  constructor(init: ToolInit) {
    this.name = init.name;
    this.description = init.description;
    this.parameters = init.parameters ?? [];
    this.handler = init.handler ?? null;
    this.maxRetries = init.maxRetries ?? 2;
    this.retryDelay = init.retryDelay ?? 0.5;
    this.dangerous = init.dangerous ?? false;
    this.cacheable = init.cacheable ?? true;
    this.cacheKeyExtra = init.cacheKeyExtra ?? null;
  }

  /** Convert to OpenAI function-calling schema (cached after first build). */
  toFunctionSchema(): FunctionSchema {
    if (this._schema !== null) {
      return this._schema;
    }
    const properties: Record<string, Record<string, unknown>> = {};
    const required: string[] = [];

    for (const p of this.parameters) {
      const prop: Record<string, unknown> = { type: p.type, description: p.description };
      if (p.default !== undefined && p.default !== null) {
        prop.default = p.default;
      }
      properties[p.name] = prop;
      if (p.required ?? true) {
        required.push(p.name);
      }
    }

    this._schema = {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: { type: 'object', properties, required },
      },
    };
    return this._schema;
  }

  async execute(
    kwargs: Record<string, any> = {},
    agentName: string | null = null,
  ): Promise<string> {
    if (this.handler === null) {
      return `Tool '${this.name}' has no handler implemented.`;
    }

    // Lightweight schema pre-check: required-field presence and primitive type
    // sanity. Returning a structured error WITH the correct signature lets the
    // model self-correct on the next turn instead of paying a handler + error
    // round-trip.
    if (this.parameters.length) {
      const sigHint = this.parameters
        .map((p) => `${p.name}:${p.type}${(p.required ?? true) ? '' : '?'}`)
        .join(', ');
      for (const p of this.parameters) {
        if ((p.required ?? true) && !(p.name in kwargs)) {
          return `Error: tool '${this.name}' missing required argument '${p.name}'. Expected signature: (${sigHint})`;
        }
      }
      for (const p of this.parameters) {
        if (!(p.name in kwargs)) continue;
        const v = kwargs[p.name];
        if (!valueMatchesSchemaType(v, p.type)) {
          const got = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
          return `Error: tool '${this.name}' argument '${p.name}' has wrong type (got ${got}, expected ${p.type}). Expected signature: (${sigHint})`;
        }
      }
    }

    // Middleware pre-hooks (ACL, rate limit, etc.) — fail-fast policy deny.
    const chain = getMiddlewareChain();
    if (chain !== null) {
      const [allowed, reason] = await chain.runPre(this.name, agentName, kwargs);
      if (!allowed) {
        return `Error: ${reason}`;
      }
    }

    // Circuit breaker — fail-fast if OPEN. The "[CircuitBreakerOpen]" prefix is
    // a contract with the agent layer: chat_stream detects it and drops the
    // offending tool from the active set for the rest of the turn.
    const breaker = getBreaker(this.name);
    if (!breaker.allowRequest()) {
      log.warning('circuit_open', { tool: this.name, state: breaker.state });
      return `Error: [CircuitBreakerOpen] Tool '${this.name}' is temporarily unavailable (breaker ${breaker.state}). Auto-retry after cooldown.`;
    }

    const shouldCache = this.cacheable && !this.dangerous;

    const buildCacheKey = (): string => {
      const base = makeCacheKey(kwargs);
      if (this.cacheKeyExtra !== null) {
        let extra: string;
        try {
          extra = this.cacheKeyExtra(kwargs);
        } catch {
          extra = 'extra_failed';
        }
        return `${base}::${extra}`;
      }
      return base;
    };

    if (shouldCache) {
      const cached = RESULT_STORE.get(this.name, buildCacheKey());
      if (cached !== null) {
        return cached;
      }
    }

    let lastError = '';
    const start = performance.now() / 1000;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const result = await this.handler(kwargs);
        if (shouldCache) {
          RESULT_STORE.set(this.name, buildCacheKey(), result);
        }
        breaker.recordSuccess();
        await Tool.runPostHooks(chain, this.name, agentName, kwargs, result, true, start);
        return result;
      } catch (e) {
        if (e instanceof TypeError) {
          log.warning('tool_bad_args', {
            tool: this.name,
            error: String(e),
            kwargs: Object.keys(kwargs),
          });
          breaker.recordFailure();
          const msg = `Error: tool '${this.name}' called with invalid arguments: ${e.message}`;
          await Tool.runPostHooks(chain, this.name, agentName, kwargs, msg, false, start);
          return msg;
        }
        lastError = e instanceof Error ? e.message : String(e);
        breaker.recordFailure();
        if (attempt < this.maxRetries) {
          log.warning('tool_retry', {
            tool: this.name,
            attempt: attempt + 1,
            error: lastError,
          });
          await sleep(this.retryDelay * 2 ** attempt * 1000);
        }
      }
    }

    log.error('tool_failed', { tool: this.name, retries: this.maxRetries, error: lastError });
    const msg = `Error executing tool '${this.name}' after ${this.maxRetries} retries: ${lastError}`;
    await Tool.runPostHooks(chain, this.name, agentName, kwargs, msg, false, start);
    return msg;
  }

  private static async runPostHooks(
    chain: MiddlewareChain | null,
    toolName: string,
    agentName: string | null,
    kwargs: Record<string, unknown>,
    result: string,
    success: boolean,
    start: number,
  ): Promise<void> {
    if (chain !== null) {
      const durationMs = (performance.now() / 1000 - start) * 1000;
      await chain.runPost(toolName, agentName, kwargs, result, success, durationMs);
    }
  }
}

/** Central registry for all tools. */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  /** Remove a tool by name. Returns true if it was registered. */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): Tool | null {
    return this.tools.get(name) ?? null;
  }

  getTools(names?: string[] | null): Tool[] {
    if (names === undefined || names === null) {
      return [...this.tools.values()];
    }
    const out: Tool[] = [];
    for (const n of names) {
      const t = this.tools.get(n);
      if (t) out.push(t);
    }
    return out;
  }

  getSchemas(names?: string[] | null): FunctionSchema[] {
    return this.getTools(names).map((t) => t.toFunctionSchema());
  }

  listNames(): string[] {
    return [...this.tools.keys()];
  }

  /** Merge another registry into this one. */
  merge(other: ToolRegistry): void {
    for (const [name, tool] of other.tools.entries()) {
      this.tools.set(name, tool);
    }
  }
}

// Global tool registry
export const globalRegistry = new ToolRegistry();
