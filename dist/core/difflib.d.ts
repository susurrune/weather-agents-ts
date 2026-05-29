/**
 * Minimal port of Python's difflib pieces used by the agent layer:
 * SequenceMatcher.ratio (Ratcliff-Obershelp / gestalt pattern matching) and
 * get_close_matches. Used for narration-loop similarity and hallucinated
 * tool-name suggestions.
 */
/** Ratcliff-Obershelp similarity in [0, 1] (Python SequenceMatcher.ratio). */
export declare function ratio(a: string, b: string): number;
/** Python difflib.get_close_matches: best `n` possibilities with ratio >= cutoff. */
export declare function getCloseMatches(word: string, possibilities: string[], n?: number, cutoff?: number): string[];
