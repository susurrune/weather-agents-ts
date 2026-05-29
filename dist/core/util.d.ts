/** Small shared helpers used across core modules. */
/**
 * Deterministic JSON with recursively sorted object keys.
 * Mirrors Python's json.dumps(sort_keys=True, ensure_ascii=False).
 * Falls back to String() for values JSON cannot represent.
 */
export declare function stableStringify(value: unknown): string;
/** Sleep for the given number of milliseconds. */
export declare function sleep(ms: number): Promise<void>;
/**
 * A minimal async mutex (mirrors asyncio.Lock). Serializes concurrent turns
 * on a single agent so their short-term message mutations don't interleave.
 */
export declare class Mutex {
    private tail;
    /** Acquire the lock; returns a release function. */
    acquire(): Promise<() => void>;
}
