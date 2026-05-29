/**
 * Lightweight structured output schemas for LLM response validation.
 *
 * Why: LLM JSON output is inherently fragile — models emit markdown fences,
 * trailing commas, unquoted keys, or hallucinated fields. Rather than layering
 * heuristic repair (which silently passes corrupted data), we define typed
 * schemas (zod) and validate on ingress. Parsing failures surface immediately
 * so the caller can retry with a corrected prompt instead of propagating
 * garbage.
 */
import { z } from 'zod';
/** Raised when an LLM response fails schema validation. Carries the raw text. */
export class SchemaValidationError extends Error {
    raw;
    constructor(message, raw = '') {
        super(message);
        this.name = 'SchemaValidationError';
        this.raw = raw;
    }
}
export const VALID_AGENTS = new Set([
    'fog',
    'rain',
    'frost',
    'snow',
    'dew',
    'fair',
]);
// ── Schema models ────────────────────────────────────────────────────────
/** One step in a task plan (mirrors PipelineStep / Task). */
export const TaskStepSchema = z.object({
    id: z.union([z.string(), z.number()]),
    description: z.string(),
    // Invalid / missing agent names fall back to "rain" (mirrors Python).
    agent: z
        .unknown()
        .optional()
        .transform((v) => (typeof v === 'string' && VALID_AGENTS.has(v) ? v : 'rain')),
    depends_on: z.array(z.coerce.string()).default([]),
    priority: z.string().default('medium'),
});
/** Full task plan output from Snow's orchestrator. */
export const TaskPlanSchema = z.object({
    goal: z.string(),
    steps: z.array(TaskStepSchema).default([]),
});
/** A single extracted fact for long-term memory. */
export const FactSchema = z.object({
    key: z.string(),
    value: z.string(),
    category: z.string().default('auto_extracted'),
});
/** Structured fact-extraction output from the LLM. */
export const ExtractionResultSchema = z.object({
    facts: z.array(FactSchema).default([]),
});
// ── Raw-text cleaning ──────────────────────────────────────────────────────
/**
 * Clean a raw LLM response into a JSON-parseable string + parsed value.
 * Handles markdown fences, leading/trailing prose, and minor JSON quirks.
 * Throws SchemaValidationError when nothing parseable is found.
 */
export function parseRawJson(raw) {
    if (!raw || !raw.trim()) {
        throw new SchemaValidationError('empty response', raw);
    }
    let cleaned = raw.trim();
    // Strip markdown code fences.
    if (cleaned.includes('```')) {
        for (const fence of ['```json', '```']) {
            if (cleaned.includes(fence)) {
                const after = cleaned.split(fence, 2)[1] ?? '';
                if (after.includes('```')) {
                    cleaned = (after.split('```', 1)[0] ?? '').trim();
                    break;
                }
            }
        }
    }
    // Find first balanced JSON object {...}.
    let objStart = -1;
    let depth = 0;
    let closed = false;
    for (let i = 0; i < cleaned.length; i++) {
        const ch = cleaned[i];
        if (ch === '{') {
            if (objStart < 0)
                objStart = i;
            depth += 1;
        }
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0 && objStart >= 0) {
                cleaned = cleaned.slice(objStart, i + 1);
                closed = true;
                break;
            }
        }
    }
    if (!closed && objStart >= 0) {
        cleaned = cleaned.slice(objStart) + '}'.repeat(depth);
    }
    try {
        return JSON.parse(cleaned);
    }
    catch (exc) {
        // Last resort: repair common issues.
        let repaired = cleaned;
        repaired = repaired.replace(/,\s*([}\]])/g, '$1'); // trailing commas
        repaired = repaired.replace(/(?<!["'\w])(\w[\w\d_]*)(\s*:)/g, '"$1"$2'); // unquoted keys
        repaired = repaired.replace(/'/g, '"').replace(/`/g, '"'); // quotes
        try {
            return JSON.parse(repaired);
        }
        catch {
            throw new SchemaValidationError(`JSON parse failed: ${String(exc)}`, raw);
        }
    }
}
/**
 * Parse a raw LLM response into a typed value validated by `schema`.
 * Throws SchemaValidationError on failure.
 */
export function parseSchema(raw, schema) {
    const data = parseRawJson(raw);
    const result = schema.safeParse(data);
    if (!result.success) {
        throw new SchemaValidationError(result.error.message, raw);
    }
    return result.data;
}
// ── Convenience parsers ──────────────────────────────────────────────────
/** Parse Snow's orchestration output into a typed task plan, or null. */
export function parseTaskPlan(raw) {
    try {
        return parseSchema(raw, TaskPlanSchema);
    }
    catch (e) {
        if (e instanceof SchemaValidationError)
            return null;
        throw e;
    }
}
/** Parse fact-extraction output into structured facts, or null. */
export function parseFacts(raw) {
    try {
        return parseSchema(raw, ExtractionResultSchema);
    }
    catch (e) {
        if (e instanceof SchemaValidationError)
            return null;
        throw e;
    }
}
//# sourceMappingURL=schemas.js.map