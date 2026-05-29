/**
 * Tool-subset selection for LLM calls.
 *
 * Without filtering, every chat turn ships ~50 tool schemas to the model,
 * diluting attention and burning input tokens. This narrows the active set to
 * ~12 by lightweight keyword scoring against the user's latest message. No
 * embeddings / LLM calls — must run in <1ms before the real LLM call.
 */
import type { ToolRegistry } from './tool.js';
/**
 * Return up to ~topK tool names ordered by relevance to the query. Always-
 * included infra tools and mustInclude are appended regardless of score. No
 * filtering when the candidate set is small or the query has <2 tokens.
 */
export declare function selectRelevantTools(registry: ToolRegistry, candidateNames: string[], query: string, opts?: {
    topK?: number;
    mustInclude?: Set<string>;
}): string[];
