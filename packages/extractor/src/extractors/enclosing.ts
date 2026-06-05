import type { ExtractedSymbol } from "../types.ts";

// Linear scan over every symbol for every call was O(calls × symbols) per
// file, which compounds across a repo. A tree-sitter walk emits symbols
// in source order, so we can sort by lineStart and binary-search for the
// deepest enclosing symbol by walking candidates whose lineStart <= callLine.
//
// The returned structure closes over a sorted snapshot; callers hit it
// once per file (by building it with sortedByLineStart) and call
// findEnclosing for every call in that file.

export interface SymbolIndex {
  findEnclosing(line: number): ExtractedSymbol | null;
}

export function buildSymbolIndex(symbols: ExtractedSymbol[]): SymbolIndex {
  // Stable-sort by lineStart. Ties broken by the original order so that
  // a method declared on the same line as its class (rare but possible
  // with one-liners) still resolves to the narrower container.
  const sorted = [...symbols].sort((a, b) => a.lineStart - b.lineStart);
  return {
    findEnclosing(line: number): ExtractedSymbol | null {
      // Binary search: largest index i such that sorted[i].lineStart <= line.
      let lo = 0;
      let hi = sorted.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid]!.lineStart <= line) lo = mid + 1;
        else hi = mid;
      }
      // Scan from the largest lineStart ≤ line downwards looking for one
      // whose lineEnd also covers `line` — the deepest enclosing symbol.
      // Methods have smaller lineStart/lineEnd ranges inside classes, so
      // when both contain the call line we prefer the tighter one (which
      // is further down in the sorted list because of stable ordering on
      // equal lineStart, but with methods always having a larger lineStart
      // than their enclosing class, the first match is already the tightest).
      for (let i = lo - 1; i >= 0; i--) {
        const s = sorted[i]!;
        if (s.lineEnd >= line) return s;
      }
      return null;
    },
  };
}
