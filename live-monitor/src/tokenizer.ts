// ----------------------------------------------------------------------------
// Vendored o200k_base BPE tokenizer (zero npm deps). Used ONLY for the
// base-category numbers in the observe Loading panel (startup inventory). All
// other estimates in this repo stay on estTok (bytes/4) — see observe.ts.
//
// Real tokenizer: pre-tokenize with the o200k_base regex, UTF-8 encode each
// piece, then byte-pair-merge by vocab rank (standard tiktoken algorithm).
// Ranks are lazy-loaded from src/vendor/o200k_base.tiktoken (base64(bytes) rank
// per line) into a singleton Map on first countTokens() call. If the vocab is
// missing/unreadable, degrade to the est fallback (Math.max(1, byteLen/4)) and
// stamp provenance 'est' so offline dev never hard-fails.
// ----------------------------------------------------------------------------



import { readFileSync } from "fs";
import { log } from "./util.ts";

// o200k_base pre-tokenization pattern. The official tiktoken pattern uses inline
// case-insensitive groups `(?i:'s|'t|…)`; those are newer V8, so we expand the
// contraction suffixes to explicit case pairs for Node ≥18 portability.
const CONTRACTIONS = "(?:'s|'S|'t|'T|'re|'RE|'rE|'Re|'ve|'VE|'vE|'Ve|'m|'M|'ll|'LL|'lL|'Ll|'d|'D)";
const O200K_PAT = new RegExp(
  CONTRACTIONS +
    "|[^\\r\\n\\p{L}\\p{N}]?[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}]*[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}]+" +
    CONTRACTIONS +
    "?|[^\\r\\n\\p{L}\\p{N}]?[\\p{Lu}\\p{Lt}\\p{Lm}\\p{Lo}\\p{M}]+[\\p{Ll}\\p{Lm}\\p{Lo}\\p{M}]*" +
    CONTRACTIONS +
    "?|\\p{N}{1,3}| ?[^\\s\\p{L}\\p{N}]+[\\r\\n/]*|\\s*[\\r\\n]|\\s+(?!\\S)|\\s+",
  "gu",
);

// bytes keyed as a latin1 string (one char per byte) → rank.
let ranks: Map<string, number> | null = null;
let loaded = false; // ranks load attempted (success or fail)
let provenance: "o200k" | "est" = "est";

function loadRanks(): void {
  if (loaded) return;
  loaded = true;
  try {
    // import.meta.url resolves under Bun dev and the Node bundle alike.
    const url = new URL("./vendor/o200k_base.tiktoken", import.meta.url);
    const raw = readFileSync(url, "utf8");
    const m = new Map<string, number>();
    for (const line of raw.split("\n")) {
      if (!line) continue;
      const sp = line.indexOf(" ");
      if (sp < 0) continue;
      const bytes = Buffer.from(line.slice(0, sp), "base64");
      const rank = Number(line.slice(sp + 1));
      if (!Number.isFinite(rank)) continue;
      m.set(bytes.toString("latin1"), rank);
    }
    if (m.size > 0) {
      ranks = m;
      provenance = "o200k";
    }
  } catch (e) {
    log("tokenizer: o200k vocab unavailable, using est fallback", e);
  }
}

// Merge a piece (latin1 byte-string) by rank; return the resulting token count.
// Classic tiktoken byte-pair-merge: parts[i] holds the start index of a token
// and the rank of the pair (part[i], part[i+1]); repeatedly merge the min-rank
// pair until none remain.
function bytePairCount(piece: string, r: Map<string, number>): number {
  if (piece.length === 1) return 1;
  const MAX = Number.MAX_SAFE_INTEGER;
  // parts: [start, rank] pairs, plus a trailing sentinel [len, MAX].
  const parts: [number, number][] = [];
  const rankOf = (start: number, end: number): number => {
    const sub = piece.slice(start, end);
    const rk = r.get(sub);
    return rk === undefined ? MAX : rk;
  };
  for (let i = 0; i < piece.length; i++) {
    parts.push([i, i + 2 <= piece.length ? rankOf(i, i + 2) : MAX]);
  }
  parts.push([piece.length, MAX]);
  while (parts.length > 1) {
    let minRank = MAX;
    let minI = -1;
    for (let i = 0; i < parts.length - 1; i++) {
      if (parts[i][1] < minRank) {
        minRank = parts[i][1];
        minI = i;
      }
    }
    if (minRank === MAX || minI < 0) break;
    // Merge parts[minI] with its neighbor: recompute the pair rank at minI (now
    // spanning to parts[minI+2]) and at minI-1.
    const at = (i: number): number => (i >= 0 && i < parts.length ? parts[i][0] : piece.length);
    parts[minI][1] = minI + 3 <= parts.length ? rankOf(parts[minI][0], at(minI + 2)) : MAX;
    if (minI > 0) {
      parts[minI - 1][1] = rankOf(parts[minI - 1][0], at(minI + 1));
    }
    parts.splice(minI + 1, 1);
  }
  return parts.length - 1;
}

// o200k token count for a string. Falls back to Math.max(1, byteLength/4) when
// the vocab is missing (provenance 'est'); empty string → 0.
export function countTokens(s: string): number {
  if (!s) return 0;
  loadRanks();
  if (!ranks) return Math.max(1, Math.ceil(Buffer.byteLength(s, "utf8") / 4));
  const r = ranks;
  let count = 0;
  const matches = s.match(O200K_PAT);
  if (!matches) return 0;
  for (const piece of matches) {
    const key = Buffer.from(piece, "utf8").toString("latin1");
    if (r.has(key)) {
      count += 1;
    } else {
      count += bytePairCount(key, r);
    }
  }
  return count;
}

// 'o200k' if the vendored vocab loaded, else 'est'. Triggers a lazy load.
export function tokenizerProvenance(): "o200k" | "est" {
  loadRanks();
  return provenance;
}
