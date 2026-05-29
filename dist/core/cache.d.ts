/**
 * Lightweight LRU cache for LLM responses.
 *
 * Deduplicates identical requests within a configurable time window.
 * Keyed by (model, messages_json) hash.
 */
export declare class LLMCache {
    private readonly maxSize;
    private readonly ttl;
    private readonly cache;
    constructor(maxSize?: number, ttlSeconds?: number);
    private makeKey;
    /** Return cached response or null if miss/expired. */
    get(model: string, messages: Array<Record<string, unknown>>, params?: Record<string, unknown> | null): string | null;
    /** Cache a non-empty response. Refuses to cache empty/very-short content. */
    set(model: string, messages: Array<Record<string, unknown>>, response: string, params?: Record<string, unknown> | null): void;
    clear(): void;
    get size(): number;
}
