import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { diffWords, diffLines } from 'diff';
import { tagAc } from '@memex-ai-ac/vitest';

// spec-448 t-7 / ac-28 — jsdiff (`diff`) is a real, resolvable dependency of
// packages/ui and is the sole diff engine for document versioning.
const AC_JSDIFF_PRESENT =
  'mindset-prod/memex-building-itself/specs/spec-448/acs/ac-28';

// spec-448 t-7 / ac-29 — no React-based diff viewer/renderer enters the tree.
// jsdiff computes diffs; rendering is ours to own, not a third-party React
// diff-viewer component.
const AC_NO_REACT_DIFF_VIEWER =
  'mindset-prod/memex-building-itself/specs/spec-448/acs/ac-29';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const UI_PKG_JSON = join(SRC_DIR, '../package.json');

describe('jsdiff dependency (spec-448 t-7)', () => {
  it('exposes diffWords/diffLines as callable functions', () => {
    tagAc(AC_JSDIFF_PRESENT);
    expect(typeof diffWords).toBe('function');
    expect(typeof diffLines).toBe('function');
  });

  it('diffWords computes the expected added/removed parts for a word change', () => {
    tagAc(AC_JSDIFF_PRESENT);
    const result = diffWords('a b', 'a c');

    // Unchanged prefix.
    const unchanged = result.filter((part) => !part.added && !part.removed);
    expect(unchanged.some((part) => part.value.includes('a'))).toBe(true);

    // 'b' is removed.
    const removed = result.filter((part) => part.removed);
    expect(removed.length).toBeGreaterThan(0);
    expect(removed.some((part) => part.value.includes('b'))).toBe(true);

    // 'c' is added.
    const added = result.filter((part) => part.added);
    expect(added.length).toBeGreaterThan(0);
    expect(added.some((part) => part.value.includes('c'))).toBe(true);
  });

  it('diff is declared as a pinned, exact-version dependency in package.json', () => {
    tagAc(AC_JSDIFF_PRESENT);
    const pkg = JSON.parse(readFileSync(UI_PKG_JSON, 'utf-8'));
    const declared = pkg.dependencies?.diff ?? pkg.devDependencies?.diff;
    expect(declared).toBeDefined();
    // Exact pin — no ^ or ~ ranges (std-24: one version per shared library).
    expect(declared).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('carries no React-based diff viewer/renderer in package.json (ac-29)', () => {
    tagAc(AC_NO_REACT_DIFF_VIEWER);
    const pkg = JSON.parse(readFileSync(UI_PKG_JSON, 'utf-8'));
    const allDeps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };
    expect(allDeps['react-diff-view']).toBeUndefined();
    expect(allDeps['react-diff-viewer-continued']).toBeUndefined();
    expect(Object.keys(allDeps).some((name) => name.startsWith('react-diff-'))).toBe(
      false,
    );
  });
});
