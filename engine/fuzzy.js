// Small fuzzy-matching helpers for "did you mean" suggestions.

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Lowercase, collapse spaces/hyphens to underscores, strip other punctuation. */
export function slug(s) {
  return String(s)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[\s\-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/** Score how well `query` matches `candidate` (lower is better, Infinity = no match). */
function score(query, candidate) {
  const q = query.replace(/_/g, "");
  const c = candidate.replace(/_/g, "");
  if (q === c) return 0;
  if (c.includes(q) || q.includes(c)) return 1 + Math.abs(c.length - q.length) / 10;
  const d = levenshtein(q, c);
  return d <= Math.max(2, Math.floor(c.length / 3)) ? 2 + d : Infinity;
}

/** Up to `n` closest candidates to `query`, best first. */
export function closest(query, candidates, n = 3) {
  const q = slug(query);
  return [...new Set(candidates)]
    .map((c) => ({ c, s: score(q, slug(c)) }))
    .filter((x) => x.s < Infinity)
    .sort((a, b) => a.s - b.s || a.c.length - b.c.length)
    .slice(0, n)
    .map((x) => x.c);
}

/**
 * Fuzzy-pick one of `items` (objects with keys) for a free-text name.
 * Matches whole slug, then words-in-order, then closest. Returns { item } or { candidates }.
 */
export function fuzzyPick(name, items, keysOf) {
  const q = slug(name);
  const keyed = items.map((item) => ({ item, keys: keysOf(item).map(slug) }));
  const exact = keyed.filter((k) => k.keys.includes(q));
  if (exact.length === 1) return { item: exact[0].item };
  const words = q.split("_").filter(Boolean);
  const wordHits = keyed.filter((k) => k.keys.some((key) => words.every((w) => key.split("_").includes(w))));
  if (wordHits.length === 1) return { item: wordHits[0].item };
  const sub = keyed.filter((k) => k.keys.some((key) => key.includes(q.replace(/_/g, "")) || key.replace(/_/g, "").includes(q.replace(/_/g, ""))));
  if (sub.length === 1) return { item: sub[0].item };
  const pool = wordHits.length ? wordHits : sub.length ? sub : keyed;
  const best = pool
    .map((k) => ({ k, s: Math.min(...k.keys.map((key) => levenshtein(q, key))) }))
    .sort((a, b) => a.s - b.s);
  if (best.length && (pool !== keyed || best[0].s <= Math.max(2, q.length / 3)) && (best.length === 1 || best[0].s < best[1].s)) {
    return { item: best[0].k.item };
  }
  return { candidates: best.slice(0, 4).map((b) => b.k.item) };
}
