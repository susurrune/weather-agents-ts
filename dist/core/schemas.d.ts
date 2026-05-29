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
export declare class SchemaValidationError extends Error {
    readonly raw: string;
    constructor(message: string, raw?: string);
}
export declare const VALID_AGENTS: ReadonlySet<string>;
/** One step in a task plan (mirrors PipelineStep / Task). */
export declare const TaskStepSchema: z.ZodObject<{
    id: z.ZodUnion<[z.ZodString, z.ZodNumber]>;
    description: z.ZodString;
    agent: z.ZodEffects<z.ZodOptional<z.ZodUnknown>, string, unknown>;
    depends_on: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    priority: z.ZodDefault<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    description: string;
    id: string | number;
    agent: string;
    depends_on: string[];
    priority: string;
}, {
    description: string;
    id: string | number;
    agent?: unknown;
    depends_on?: string[] | undefined;
    priority?: string | undefined;
}>;
export type TaskStep = z.infer<typeof TaskStepSchema>;
/** Full task plan output from Snow's orchestrator. */
export declare const TaskPlanSchema: z.ZodObject<{
    goal: z.ZodString;
    steps: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodUnion<[z.ZodString, z.ZodNumber]>;
        description: z.ZodString;
        agent: z.ZodEffects<z.ZodOptional<z.ZodUnknown>, string, unknown>;
        depends_on: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        priority: z.ZodDefault<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        description: string;
        id: string | number;
        agent: string;
        depends_on: string[];
        priority: string;
    }, {
        description: string;
        id: string | number;
        agent?: unknown;
        depends_on?: string[] | undefined;
        priority?: string | undefined;
    }>, "many">>;
}, "strip", z.ZodTypeAny, {
    goal: string;
    steps: {
        description: string;
        id: string | number;
        agent: string;
        depends_on: string[];
        priority: string;
    }[];
}, {
    goal: string;
    steps?: {
        description: string;
        id: string | number;
        agent?: unknown;
        depends_on?: string[] | undefined;
        priority?: string | undefined;
    }[] | undefined;
}>;
export type TaskPlan = z.infer<typeof TaskPlanSchema>;
/** A single extracted fact for long-term memory. */
export declare const FactSchema: z.ZodObject<{
    key: z.ZodString;
    value: z.ZodString;
    category: z.ZodDefault<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    value: string;
    key: string;
    category: string;
}, {
    value: string;
    key: string;
    category?: string | undefined;
}>;
export type Fact = z.infer<typeof FactSchema>;
/** Structured fact-extraction output from the LLM. */
export declare const ExtractionResultSchema: z.ZodObject<{
    facts: z.ZodDefault<z.ZodArray<z.ZodObject<{
        key: z.ZodString;
        value: z.ZodString;
        category: z.ZodDefault<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        value: string;
        key: string;
        category: string;
    }, {
        value: string;
        key: string;
        category?: string | undefined;
    }>, "many">>;
}, "strip", z.ZodTypeAny, {
    facts: {
        value: string;
        key: string;
        category: string;
    }[];
}, {
    facts?: {
        value: string;
        key: string;
        category?: string | undefined;
    }[] | undefined;
}>;
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;
/**
 * Clean a raw LLM response into a JSON-parseable string + parsed value.
 * Handles markdown fences, leading/trailing prose, and minor JSON quirks.
 * Throws SchemaValidationError when nothing parseable is found.
 */
export declare function parseRawJson(raw: string): unknown;
/**
 * Parse a raw LLM response into a typed value validated by `schema`.
 * Throws SchemaValidationError on failure.
 */
export declare function parseSchema<S extends z.ZodTypeAny>(raw: string, schema: S): z.output<S>;
/** Parse Snow's orchestration output into a typed task plan, or null. */
export declare function parseTaskPlan(raw: string): TaskPlan | null;
/** Parse fact-extraction output into structured facts, or null. */
export declare function parseFacts(raw: string): ExtractionResult | null;
