/**
 * LLM abstraction layer with retry, fallback, cost tracking, and budget control.
 *
 * The Python original wraps LiteLLM; this port wraps the Vercel AI SDK
 * (`ai` + `@ai-sdk/*`). The provider call is isolated behind `CompletionBackend`
 * so all orchestration logic (fallback chains, retries, usage/cost tracking,
 * budget, caching, user-facing error formatting) is provider-agnostic and unit
 * testable with a fake backend — mirroring how the Python tests mock litellm.
 */
import { type AppConfig } from './config.js';
import type { FunctionSchema, ToolRegistry } from './tool.js';
/** Return [provider, strippedModel] if model looks like `<provider>/<name>`. */
export declare function splitProvider(model: string): [string | null, string];
/** True when the model targets Anthropic's API. */
export declare function isAnthropicModel(model: string): boolean;
export declare function formatUserFacingError(model: string, err: unknown): string;
export declare function estimateTokens(text: string): number;
export declare const FALLBACK_CHAINS: Record<string, string[]>;
export declare function isTransientError(exc: unknown): boolean;
export declare function estimateCost(model: string, promptTokens: number, completionTokens: number): number;
export interface ToolCall {
    id: string;
    type: string;
    function: {
        name: string;
        arguments: string;
    };
}
export interface LLMResponse {
    content: string;
    toolCalls: ToolCall[];
    model: string;
    usage: {
        prompt_tokens?: number;
        completion_tokens?: number;
    };
    cost: number;
    reasoningContent: string | null;
    truncated: boolean;
}
export type StreamEventType = 'content' | 'tool_call' | 'done' | 'error' | 'reasoning';
export interface StreamEvent {
    type: StreamEventType;
    text: string;
    toolCall: ToolCall | null;
    usage: {
        prompt_tokens?: number;
        completion_tokens?: number;
    } | null;
    reasoningContent: string | null;
}
export interface CompletionRequest {
    model: string;
    provider: string | null;
    strippedModel: string;
    messages: Array<Record<string, any>>;
    tools: FunctionSchema[] | null;
    temperature: number;
    maxTokens: number;
    timeout: number;
}
export interface RawCompletion {
    content: string;
    toolCalls: ToolCall[];
    reasoningContent: string | null;
    promptTokens: number;
    completionTokens: number;
    model: string;
}
export type RawStreamChunk = {
    kind: 'content';
    text: string;
} | {
    kind: 'reasoning';
    text: string;
} | {
    kind: 'tool_call';
    toolCall: ToolCall;
} | {
    kind: 'usage';
    promptTokens: number;
    completionTokens: number;
};
export interface CompletionBackend {
    complete(req: CompletionRequest): Promise<RawCompletion>;
    stream(req: CompletionRequest): AsyncIterable<RawStreamChunk>;
}
interface UsageStat {
    prompt_tokens: number;
    completion_tokens: number;
    calls: number;
    cost: number;
}
export declare class LLMClient {
    readonly config: AppConfig;
    readonly toolRegistry: ToolRegistry;
    private readonly cache;
    private readonly backend;
    private usageStats;
    private totalCost;
    private readonly costLimit;
    constructor(config: AppConfig, toolRegistry: ToolRegistry, opts?: {
        costLimit?: number | null;
        backend?: CompletionBackend;
    });
    private getModel;
    private getRetries;
    private trackUsage;
    getUsageStats(): Record<string, UsageStat>;
    getTotalCost(): number;
    resetUsageStats(): void;
    private checkBudget;
    private hasKeyForModel;
    complete(messages: Array<Record<string, any>>, opts?: {
        agentName?: string | null;
        tools?: string[] | null;
        stream?: boolean;
        overrides?: Record<string, any> | null;
    }): Promise<LLMResponse>;
    private errorResponse;
    private completeWithRetry;
    /** Plain text streaming (no tools). */
    stream(messages: Array<Record<string, any>>, agentName?: string | null): AsyncIterator<string> & AsyncIterable<string>;
    /**
     * Stream completion with tool-call awareness.
     *
     * Fallback chains apply only BEFORE the first chunk — once content has
     * streamed we commit to the model; later errors become terminal "error"
     * events. Tool calls are emitted fully-accumulated after the stream ends
     * (arguments arrive across chunks).
     */
    streamWithTools(messages: Array<Record<string, any>>, opts?: {
        agentName?: string | null;
        tools?: string[] | null;
        toolRegistry?: ToolRegistry | null;
        overrides?: Record<string, any> | null;
    }): AsyncGenerator<StreamEvent>;
    private streamEvent;
}
export declare class AiSdkBackend implements CompletionBackend {
    private makeModel;
    private buildTools;
    complete(req: CompletionRequest): Promise<RawCompletion>;
    stream(req: CompletionRequest): AsyncIterable<RawStreamChunk>;
}
export {};
