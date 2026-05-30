/**
 * Lightweight LRU cache for LLM responses.
 *
 * Deduplicates identical requests within a configurable time window.
 * Keyed by (model, messages_json) hash.
 */
import { createHash } from 'node:crypto';
/** Deterministic JSON with recursively sorted object keys (mirrors json.dumps(sort_keys=True)). */
function stableStringify(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }
    const obj = value;
    const keys = Object.keys(obj).sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
    return `{${parts.join(',')}}`;
}
/** Wall-clock seconds (mirrors Python time.time). */
function nowSeconds() {
    return Date.now() / 1000;
}
export class LLMCache {
    maxSize;
    ttl;
    // Map preserves insertion order; we delete+set on access to emulate LRU.
    cache = new Map();
    constructor(maxSize = 128, ttlSeconds = 60) {
        this.maxSize = maxSize;
        this.ttl = ttlSeconds;
    }
    makeKey(model, messages, params = null) {
        const raw = stableStringify([model, messages, params ?? {}]);
        return createHash('sha256').update(raw, 'utf-8').digest('hex').slice(0, 32);
    }
    /** Return cached response or null if miss/expired. */
    get(model, messages, params = null) {
        const key = this.makeKey(model, messages, params);
        const entry = this.cache.get(key);
        if (entry === undefined) {
            return null;
        }
        if (nowSeconds() - entry.ts >= this.ttl) {
            this.cache.delete(key);
            return null;
        }
        // move-to-end (most recently used)
        this.cache.delete(key);
        this.cache.set(key, entry);
        return entry.response;
    }
    /** Cache a non-empty response. Refuses to cache empty/very-short content. */
    set(model, messages, response, params = null) {
        if (!response || response.length < 10) {
            return;
        }
        const key = this.makeKey(model, messages, params);
        this.cache.delete(key);
        this.cache.set(key, { ts: nowSeconds(), response });
        while (this.cache.size > this.maxSize) {
            // pop oldest (first inserted)
            const oldest = this.cache.keys().next().value;
            if (oldest === undefined)
                break;
            this.cache.delete(oldest);
        }
    }
    clear() {
        this.cache.clear();
    }
    get size() {
        return this.cache.size;
    }
}
