/** Small shared helpers used across core modules. */
/**
 * Deterministic JSON with recursively sorted object keys.
 * Mirrors Python's json.dumps(sort_keys=True, ensure_ascii=False).
 * Falls back to String() for values JSON cannot represent.
 */
export function stableStringify(value) {
    const seen = new WeakSet();
    const walk = (v) => {
        if (v === null)
            return 'null';
        const t = typeof v;
        if (t === 'number' || t === 'boolean')
            return JSON.stringify(v);
        if (t === 'string')
            return JSON.stringify(v);
        if (t === 'bigint' || t === 'function' || t === 'symbol' || t === 'undefined') {
            return JSON.stringify(String(v));
        }
        const obj = v;
        if (seen.has(obj))
            return '"[Circular]"';
        seen.add(obj);
        let out;
        if (Array.isArray(obj)) {
            out = `[${obj.map(walk).join(',')}]`;
        }
        else {
            const rec = obj;
            const keys = Object.keys(rec).sort();
            out = `{${keys.map((k) => `${JSON.stringify(k)}:${walk(rec[k])}`).join(',')}}`;
        }
        seen.delete(obj);
        return out;
    };
    return walk(value);
}
/** Sleep for the given number of milliseconds. */
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * A minimal async mutex (mirrors asyncio.Lock). Serializes concurrent turns
 * on a single agent so their short-term message mutations don't interleave.
 */
export class Mutex {
    tail = Promise.resolve();
    /** Acquire the lock; returns a release function. */
    async acquire() {
        let release;
        const next = new Promise((resolve) => {
            release = resolve;
        });
        const prev = this.tail;
        this.tail = this.tail.then(() => next);
        await prev;
        return release;
    }
}
