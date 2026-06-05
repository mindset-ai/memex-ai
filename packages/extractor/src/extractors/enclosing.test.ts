import { describe, expect, it } from "vitest";
import type { ExtractedSymbol } from "../types.ts";
import { buildSymbolIndex } from "./enclosing.ts";

function sym(
  name: string,
  lineStart: number,
  lineEnd: number,
  overrides: Partial<ExtractedSymbol> = {},
): ExtractedSymbol {
  return {
    name,
    kind: "function",
    parentName: null,
    signature: `function ${name}()`,
    lineStart,
    lineEnd,
    isExported: false,
    isAsync: false,
    language: "typescript",
    docComment: null,
    ...overrides,
  };
}

describe("buildSymbolIndex / findEnclosing", () => {
  it("returns null for an empty symbol list", () => {
    expect(buildSymbolIndex([]).findEnclosing(10)).toBeNull();
  });

  it("finds the sole symbol when line is inside its range", () => {
    const idx = buildSymbolIndex([sym("foo", 5, 20)]);
    expect(idx.findEnclosing(10)?.name).toBe("foo");
  });

  it("returns null for a line outside every symbol", () => {
    const idx = buildSymbolIndex([sym("foo", 5, 20)]);
    expect(idx.findEnclosing(3)).toBeNull();
    expect(idx.findEnclosing(25)).toBeNull();
  });

  it("prefers the tighter enclosing symbol (method inside class)", () => {
    // class Foo spans 1-30; method bar spans 10-20. A call at line 15
    // must resolve to bar (the tighter of the two containers), not Foo.
    const classSym = sym("Foo", 1, 30, { kind: "class" });
    const methodSym = sym("bar", 10, 20, { kind: "method", parentName: "Foo" });
    const idx = buildSymbolIndex([classSym, methodSym]);
    expect(idx.findEnclosing(15)?.name).toBe("bar");
  });

  it("falls back to the outer container when line is outside the inner", () => {
    const classSym = sym("Foo", 1, 30, { kind: "class" });
    const methodSym = sym("bar", 10, 20, { kind: "method", parentName: "Foo" });
    const idx = buildSymbolIndex([classSym, methodSym]);
    // Line 25 is in Foo but not in bar — should return Foo.
    expect(idx.findEnclosing(25)?.name).toBe("Foo");
  });

  it("is stable when symbols are passed out of source order", () => {
    // Giving the index an unsorted list must not change behaviour —
    // it sorts internally. Proves the binary-search invariants hold.
    const a = sym("a", 5, 10);
    const b = sym("b", 20, 30);
    const c = sym("c", 40, 50);
    const shuffled = buildSymbolIndex([c, a, b]);
    expect(shuffled.findEnclosing(7)?.name).toBe("a");
    expect(shuffled.findEnclosing(25)?.name).toBe("b");
    expect(shuffled.findEnclosing(45)?.name).toBe("c");
    expect(shuffled.findEnclosing(35)).toBeNull();
  });

  it("handles adjacent symbols with shared boundaries", () => {
    // foo: 1-10, bar: 11-20. Line 10 should be foo; line 11 should be bar.
    const idx = buildSymbolIndex([sym("foo", 1, 10), sym("bar", 11, 20)]);
    expect(idx.findEnclosing(10)?.name).toBe("foo");
    expect(idx.findEnclosing(11)?.name).toBe("bar");
  });

  it("handles many symbols correctly (stress test)", () => {
    // 1000 non-overlapping symbols; binary search must find the right one.
    const symbols: ExtractedSymbol[] = [];
    for (let i = 0; i < 1000; i++) {
      const start = i * 10 + 1;
      symbols.push(sym(`s${i}`, start, start + 8));
    }
    const idx = buildSymbolIndex(symbols);
    expect(idx.findEnclosing(1)?.name).toBe("s0");
    expect(idx.findEnclosing(505)?.name).toBe("s50"); // 501-509
    expect(idx.findEnclosing(9995)?.name).toBe("s999"); // 9991-9999
    // Gaps between symbols return null
    expect(idx.findEnclosing(10)).toBeNull(); // 9-11 gap
  });
});
