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
export class SemanticScorer {
    nMin;
    nMax;
    cache = new Map();
    constructor(nRange = [2, 4]) {
        this.nMin = nRange[0];
        this.nMax = nRange[1];
    }
    /** Compute character n-gram fingerprint (cached, bounded to 512 entries). */
    fingerprint(text) {
        const cached = this.cache.get(text);
        if (cached !== undefined)
            return cached;
        const lowered = text.toLowerCase();
        const ngrams = new Set();
        for (let n = this.nMin; n <= this.nMax; n++) {
            if (lowered.length < n)
                continue;
            for (let i = 0; i <= lowered.length - n; i++) {
                ngrams.add(lowered.slice(i, i + n));
            }
        }
        if (this.cache.size < 512) {
            this.cache.set(text, ngrams);
        }
        return ngrams;
    }
    /** Jaccard similarity on character n-gram sets. */
    similarity(a, b) {
        if (!a || !b)
            return 0.0;
        const fpA = this.fingerprint(a);
        const fpB = this.fingerprint(b);
        if (fpA.size === 0 || fpB.size === 0)
            return 0.0;
        let intersection = 0;
        // Iterate the smaller set for fewer lookups.
        const [small, large] = fpA.size <= fpB.size ? [fpA, fpB] : [fpB, fpA];
        for (const g of small) {
            if (large.has(g))
                intersection += 1;
        }
        const union = fpA.size + fpB.size - intersection;
        return union > 0 ? intersection / union : 0.0;
    }
    /**
     * Rank candidates by semantic similarity to the query.
     * Each candidate dict's `keyField` (default "value") supplies the compare
     * text; the "key" field is also scored (often more discriminative).
     * Returns [score, candidate] tuples sorted descending, filtered by minScore.
     */
    rank(query, candidates, opts = {}) {
        const keyField = opts.keyField ?? 'value';
        const topK = opts.topK ?? 3;
        const minScore = opts.minScore ?? 0.02;
        const scored = [];
        for (const c of candidates) {
            let text = c[keyField];
            if (!text)
                continue;
            if (typeof text === 'object')
                text = String(text);
            let score = this.similarity(query, text);
            const keyText = c.key ?? '';
            if (keyText) {
                score = Math.max(score, this.similarity(query, String(keyText)));
            }
            if (score >= minScore) {
                scored.push([score, c]);
            }
        }
        scored.sort((a, b) => b[0] - a[0]);
        return scored.slice(0, topK);
    }
}
// Module-level singleton (initialized lazily).
let _scorer = null;
export function getScorer() {
    if (_scorer === null) {
        _scorer = new SemanticScorer();
    }
    return _scorer;
}
