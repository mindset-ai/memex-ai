import '@testing-library/jest-dom/vitest';
// Install Memex AC emission hooks (spec-89): the @memex-ai-ac/vitest
// package's setup module registers beforeEach/afterEach so any test
// calling tagAc('<canonical-ac-ref>') POSTs a pass/fail event to the
// namespace-derived Memex server. Untagged tests emit nothing.
import '@memex-ai-ac/vitest/setup';

// jsdom doesn't implement scrollIntoView
Element.prototype.scrollIntoView = () => {};

// spec-136: Node 22+/25 ship an experimental built-in `localStorage` global that,
// without the `--localstorage-file` flag, shadows jsdom's Storage and throws
// "localStorage.getItem is not a function" the moment any auth/storage code runs
// (e.g. http.ts withAutoAuth, SpecList's show-paused toggle). Install a real
// in-memory Storage so the jsdom environment behaves like a browser. Persists
// within a test file (matching jsdom's prior behaviour); does not auto-clear
// between tests — suites that assert persistence clear it themselves.
class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}
for (const prop of ['localStorage', 'sessionStorage'] as const) {
  const storage = new MemoryStorage();
  Object.defineProperty(window, prop, { value: storage, configurable: true, writable: true });
  Object.defineProperty(globalThis, prop, { value: storage, configurable: true, writable: true });
}

// jsdom doesn't implement ResizeObserver (SectionCard uses it to keep comment
// indicators aligned to their anchored lines). A no-op stub suffices — the
// initial measure() runs synchronously on mount.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// jsdom doesn't implement the CSS Custom Highlight API (spec-100's geo-anchor
// highlight and spec-448's version-diff highlight both build DOM Ranges and
// register them via `new Highlight(...)` + `CSS.highlights.set(...)`). A
// minimal polyfill — just enough surface for those call sites to run to
// completion instead of silently hitting their `typeof Highlight ===
// 'undefined'` no-op guard — lets tests assert the highlight registry itself,
// not just the Range-building logic that feeds it.
if (typeof globalThis.Highlight === 'undefined') {
  class HighlightPolyfill {
    readonly ranges: Range[];
    constructor(...ranges: Range[]) {
      this.ranges = ranges;
    }
  }
  globalThis.Highlight = HighlightPolyfill as unknown as typeof Highlight;
}
const cssHighlights = CSS as unknown as { highlights?: Map<string, unknown> };
if (!cssHighlights.highlights) {
  cssHighlights.highlights = new Map();
}
