/** Tool registration and execution framework with retry support. */
/** Tool handler: receives the call args as an object, returns a string result. */
export type ToolHandler = (args: Record<string, any>) => Promise<string>;
/**
 * Process-wide tool result cache. Survives tool unregister/reregister
 * (skill activation cycles, MCP reconnects). Bounded by CACHE_MAXSIZE
 * entries per tool name (LRU via Map insertion order).
 */
declare class ToolResultStore {
    private readonly store;
    get(toolName: string, key: string): string | null;
    set(toolName: string, key: string, value: string): void;
    clear(toolName?: string): void;
}
/** Exported so tests can isolate state between cases (mirrors _RESULT_STORE). */
export declare const RESULT_STORE: ToolResultStore;
export interface ToolParameter {
    name: string;
    type: string;
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
export declare class Tool {
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
    private _schema;
    constructor(init: ToolInit);
    /** Convert to OpenAI function-calling schema (cached after first build). */
    toFunctionSchema(): FunctionSchema;
    execute(kwargs?: Record<string, any>, agentName?: string | null): Promise<string>;
    private static runPostHooks;
}
/** Central registry for all tools. */
export declare class ToolRegistry {
    private readonly tools;
    register(tool: Tool): void;
    /** Remove a tool by name. Returns true if it was registered. */
    unregister(name: string): boolean;
    get(name: string): Tool | null;
    getTools(names?: string[] | null): Tool[];
    getSchemas(names?: string[] | null): FunctionSchema[];
    listNames(): string[];
    /** Merge another registry into this one. */
    merge(other: ToolRegistry): void;
}
export declare const globalRegistry: ToolRegistry;
export {};
