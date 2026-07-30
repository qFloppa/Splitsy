/**
 * Pure search-scoring helpers shared by DocsSearchInput and its test.
 * Extracted so the non-trivial matching logic is runnable without a DOM.
 */

/** Subsequence fuzzy match. Returns a score (higher = better) or null if no match. */
export function fuzzyScore(haystack: string, needle: string): number | null {
  if (!needle) return 0;
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();

  // Substring is the strong case — reward it heavily and exit fast.
  const subIdx = h.indexOf(n);
  if (subIdx !== -1) {
    let bonus = 100;
    // Word-boundary prefix bonus: "split" in "bill split" beats "split" mid-word.
    if (subIdx === 0 || /\s|-|_/.test(h[subIdx - 1] ?? "")) bonus += 30;
    return bonus + n.length;
  }

  // Fall back to subsequence matching with a proximity bonus.
  let score = 0;
  let hi = 0;
  for (let ni = 0; ni < n.length; ni++) {
    const c = n[ni];
    let found = -1;
    for (let j = hi; j < h.length; j++) {
      if (h[j] === c) { found = j; break; }
    }
    if (found === -1) return null;
    // Tighter gaps score higher.
    score += 10 - Math.min(8, found - hi);
    hi = found + 1;
  }
  return Math.max(score, 1);
}

/** AND-semantics across words: every word must fuzzy-match somewhere in text. */
export function matchAll(text: string, words: string[]): { score: number } | null {
  let total = 0;
  for (const w of words) {
    const s = fuzzyScore(text, w);
    if (s === null) return null;
    total += s;
  }
  return { score: total };
}
