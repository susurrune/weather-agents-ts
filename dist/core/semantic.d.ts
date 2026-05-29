/**
 * Lightweight semantic retrieval — zero external dependencies.
 *
 * Character n-gram Jaccard similarity. Catches cross-lingual / synonym /
 * code-identifier relationships that SQL LIKE on tokens misses, without
 * pulling in embeddings models.
 *
 * - n-grams (size 2-4) handle CJK, mixed-language, and code identifiers.
 * - Jaccard on n-gram sets is fast and correlates well with relevance for
 *   short text.
 */
export declare class SemanticScorer {
    private readonly nMin;
    private readonly nMax;
    private readonly cache;
    constructor(nRange?: [number, number]);
    /** Compute character n-gram fingerprint (cached, bounded to 512 entries). */
    private fingerprint;
    /** Jaccard similarity on character n-gram sets. */
    similarity(a: string, b: string): number;
    /**
     * Rank candidates by semantic similarity to the query.
     * Each candidate dict's `keyField` (default "value") supplies the compare
     * text; the "key" field is also scored (often more discriminative).
     * Returns [score, candidate] tuples sorted descending, filtered by minScore.
     */
    rank(query: string, candidates: Array<Record<string, any>>, opts?: {
        keyField?: string;
        topK?: number;
        minScore?: number;
    }): Array<[number, Record<string, any>]>;
}
export declare function getScorer(): SemanticScorer;
