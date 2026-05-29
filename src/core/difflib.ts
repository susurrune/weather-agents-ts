/**
 * Minimal port of Python's difflib pieces used by the agent layer:
 * SequenceMatcher.ratio (Ratcliff-Obershelp / gestalt pattern matching) and
 * get_close_matches. Used for narration-loop similarity and hallucinated
 * tool-name suggestions.
 */

/** Longest matching block in a[alo:ahi] vs b[blo:bhi] → [i, j, size]. */
function findLongestMatch(
  a: string,
  b: string,
  alo: number,
  ahi: number,
  blo: number,
  bhi: number,
): [number, number, number] {
  const b2j = new Map<string, number[]>();
  for (let j = blo; j < bhi; j++) {
    const c = b[j]!;
    const arr = b2j.get(c);
    if (arr) arr.push(j);
    else b2j.set(c, [j]);
  }

  let besti = alo;
  let bestj = blo;
  let bestsize = 0;
  let j2len = new Map<number, number>();
  for (let i = alo; i < ahi; i++) {
    const newj2len = new Map<number, number>();
    for (const j of b2j.get(a[i]!) ?? []) {
      if (j < blo || j >= bhi) continue;
      const k = (j2len.get(j - 1) ?? 0) + 1;
      newj2len.set(j, k);
      if (k > bestsize) {
        besti = i - k + 1;
        bestj = j - k + 1;
        bestsize = k;
      }
    }
    j2len = newj2len;
  }
  return [besti, bestj, bestsize];
}

function sumMatches(
  a: string,
  b: string,
  alo: number,
  ahi: number,
  blo: number,
  bhi: number,
): number {
  const [i, j, k] = findLongestMatch(a, b, alo, ahi, blo, bhi);
  if (k === 0) return 0;
  return k + sumMatches(a, b, alo, i, blo, j) + sumMatches(a, b, i + k, ahi, j + k, bhi);
}

/** Ratcliff-Obershelp similarity in [0, 1] (Python SequenceMatcher.ratio). */
export function ratio(a: string, b: string): number {
  const total = a.length + b.length;
  if (total === 0) return 1.0;
  return (2 * sumMatches(a, b, 0, a.length, 0, b.length)) / total;
}

/** Python difflib.get_close_matches: best `n` possibilities with ratio >= cutoff. */
export function getCloseMatches(
  word: string,
  possibilities: string[],
  n = 3,
  cutoff = 0.6,
): string[] {
  const scored: Array<[number, string]> = [];
  for (const p of possibilities) {
    const r = ratio(word, p);
    if (r >= cutoff) scored.push([r, p]);
  }
  scored.sort((x, y) => y[0] - x[0]);
  return scored.slice(0, n).map(([, p]) => p);
}
