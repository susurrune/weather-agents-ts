/**
 * Tool-subset selection for LLM calls.
 *
 * Without filtering, every chat turn ships ~50 tool schemas to the model,
 * diluting attention and burning input tokens. This narrows the active set to
 * ~12 by lightweight keyword scoring against the user's latest message. No
 * embeddings / LLM calls — must run in <1ms before the real LLM call.
 */
// Infrastructure tools that must ALWAYS be visible regardless of query.
const ALWAYS_INCLUDE = new Set([
    'delegate_to',
    'list_skills',
    'use_skill',
    'recall_facts',
    'remember_fact',
]);
const TOKEN_RE = /[A-Za-z][A-Za-z0-9_]*|[一-鿿]+/g;
const STOPWORDS = new Set([
    'a',
    'an',
    'the',
    'is',
    'are',
    'was',
    'were',
    'and',
    'or',
    'but',
    'to',
    'for',
    'of',
    'in',
    'on',
    'at',
    'with',
    'by',
    'do',
    'did',
    'does',
    'i',
    'me',
    'my',
    'you',
    'your',
    'it',
    'this',
    'that',
    'what',
    'how',
    'can',
    'could',
    'would',
    'should',
    'please',
    'tell',
    'show',
    'help',
    'ok',
    'yes',
    'no',
    '好',
    '的',
    '是',
    '我',
    '你',
    '他',
    '她',
    '它',
    '这',
    '那',
    '什么',
    '怎么',
    '请',
    '帮',
    '麻烦',
]);
function tokenize(text) {
    const out = new Set();
    for (const m of (text || '').matchAll(TOKEN_RE)) {
        const t = m[0];
        const lower = t.toLowerCase();
        if (t.length >= 2 && !STOPWORDS.has(lower))
            out.add(lower);
    }
    return out;
}
function scoreTool(tool, queryTokens) {
    if (queryTokens.size === 0)
        return 0;
    let score = 0;
    const nameTokens = tokenize(tool.name.replace(/_/g, ' '));
    const nameLower = tool.name.toLowerCase();
    for (const qt of queryTokens) {
        if (nameTokens.has(qt))
            score += 5;
        else if (nameLower.includes(qt))
            score += 3;
    }
    const descTokens = tokenize(tool.description);
    for (const qt of queryTokens) {
        if (descTokens.has(qt))
            score += 1;
    }
    return score;
}
/**
 * Return up to ~topK tool names ordered by relevance to the query. Always-
 * included infra tools and mustInclude are appended regardless of score. No
 * filtering when the candidate set is small or the query has <2 tokens.
 */
export function selectRelevantTools(registry, candidateNames, query, opts = {}) {
    const topK = opts.topK ?? 12;
    const must = new Set([...(opts.mustInclude ?? []), ...ALWAYS_INCLUDE]);
    const mustPresent = candidateNames.filter((n) => must.has(n));
    const remaining = candidateNames.filter((n) => !must.has(n));
    const queryTokens = tokenize(query);
    if (remaining.length <= topK || queryTokens.size < 2) {
        return [...mustPresent, ...remaining];
    }
    const scored = [];
    for (const name of remaining) {
        const tool = registry.get(name);
        if (tool === null)
            continue;
        scored.push([scoreTool(tool, queryTokens), name]);
    }
    scored.sort((a, b) => b[0] - a[0]);
    const picked = scored.slice(0, topK).map(([, n]) => n);
    return [...mustPresent, ...picked];
}
