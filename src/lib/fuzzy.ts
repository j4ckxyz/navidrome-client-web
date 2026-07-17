// Lightweight fuzzy matching for search. No index, no dependencies — just a
// scorer tuned for "did the user mean this song/artist/album" with typo
// tolerance, plus helpers to expand a query into server-search variants.

// Lowercase, strip diacritics, collapse everything non-alphanumeric to spaces.
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Damerau-Levenshtein distance with early exit once it exceeds `cap`.
function editDistance(a: string, b: string, cap: number): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const m = a.length;
  const n = b.length;
  let prev2: number[] = [];
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      // transposition
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > cap) return cap + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[n];
}

// How close two normalized strings are on spelling alone: 1 = identical,
// 0 = further than the allowed typo budget.
function typoScore(query: string, text: string): number {
  const cap = query.length <= 4 ? 1 : query.length <= 8 ? 2 : 3;
  const d = editDistance(query, text, cap);
  if (d > cap) return 0;
  return 1 - d / (query.length + 1);
}

// Score `query` against a candidate string. 0..1; anything under ~0.5 is junk.
export function fuzzyScore(rawQuery: string, rawText: string): number {
  const query = normalizeText(rawQuery);
  const text = normalizeText(rawText);
  if (!query || !text) return 0;
  if (query === text) return 1;
  if (text.startsWith(query)) return 0.95;

  let best = 0;
  if (text.includes(query)) {
    // Substring: stronger the more of the text it explains.
    best = 0.8 + 0.1 * (query.length / text.length);
  }

  // Whole-string typo tolerance ("bohemian rapsody" → "bohemian rhapsody").
  best = Math.max(best, typoScore(query, text) * 0.9);

  // Word-level matching: every query word should find a home in the text —
  // as a prefix, substring, or near-typo of some text word.
  const qWords = query.split(" ");
  const tWords = text.split(" ");
  let covered = 0;
  for (const qw of qWords) {
    let wordBest = 0;
    for (const tw of tWords) {
      if (tw === qw) wordBest = 1;
      else if (tw.startsWith(qw)) wordBest = Math.max(wordBest, 0.9);
      else if (qw.length >= 3 && tw.includes(qw)) wordBest = Math.max(wordBest, 0.75);
      else if (qw.length >= 4) wordBest = Math.max(wordBest, typoScore(qw, tw) * 0.85);
      if (wordBest === 1) break;
    }
    covered += wordBest;
  }
  const coverage = covered / qWords.length;
  // Full coverage of a multi-word query is a strong signal even if the text has
  // extra words ("bohemian rhapsody" matching "Bohemian Rhapsody - Live Aid").
  best = Math.max(best, coverage * (qWords.length > 1 ? 0.85 : 0.7));

  return best;
}

// Query variants to throw at a server whose search is exact-prefix only:
// the raw query, its individual words, and trailing-typo-trimmed prefixes.
// Deduped; capped so a long query doesn't fan out into a request storm.
export function queryVariants(rawQuery: string): string[] {
  const query = rawQuery.trim();
  const out = new Set<string>([query]);
  const words = normalizeText(query).split(" ").filter((w) => w.length >= 3);
  for (const w of words.slice(0, 3)) out.add(w);
  // "bohemain" finds nothing, but its prefix "bohem" does.
  if (query.length >= 5) out.add(query.slice(0, -1));
  if (query.length >= 6) out.add(query.slice(0, -2));
  return [...out].slice(0, 6);
}
