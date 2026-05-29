/** Small shared helpers used across core modules. */

/**
 * Deterministic JSON with recursively sorted object keys.
 * Mirrors Python's json.dumps(sort_keys=True, ensure_ascii=False).
 * Falls back to String() for values JSON cannot represent.
 */
export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): string => {
    if (v === null) return 'null';
    const t = typeof v;
    if (t === 'number' || t === 'boolean') return JSON.stringify(v);
    if (t === 'string') return JSON.stringify(v);
    if (t === 'bigint' || t === 'function' || t === 'symbol' || t === 'undefined') {
      return JSON.stringify(String(v));
    }
    const obj = v as object;
    if (seen.has(obj)) return '"[Circular]"';
    seen.add(obj);
    let out: string;
    if (Array.isArray(obj)) {
      out = `[${obj.map(walk).join(',')}]`;
    } else {
      const rec = obj as Record<string, unknown>;
      const keys = Object.keys(rec).sort();
      out = `{${keys.map((k) => `${JSON.stringify(k)}:${walk(rec[k])}`).join(',')}}`;
    }
    seen.delete(obj);
    return out;
  };
  return walk(value);
}

/** Sleep for the given number of milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
