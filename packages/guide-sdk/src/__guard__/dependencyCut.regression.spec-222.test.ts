// spec-222 t-2 (dec-5 / dec-2) — the structural guard that keeps the dependency
// cut from regressing. ac-9: "packages/guide-sdk has zero static imports of
// react-router* or @memex/shared, enforced by a dependency/lint rule that fails
// CI on violation."
//
// This is that rule. It runs in CI (vitest, per .github/workflows/test.yml), so a
// forbidden import re-entering the engine FAILS the build — the standing guard
// against the one-source-two-consumers drift risk. The navigation coupling is
// satisfied ONLY through the injected NavigationAdapter (dec-2); if a future change
// reaches for react-router or @memex/shared inside the engine, this test goes red.

import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const AC_9 = 'mindset-prod/memex-building-itself/specs/spec-222/acs/ac-9';

const here = dirname(fileURLToPath(import.meta.url)); // .../guide-sdk/src/__guard__
const SDK_SRC = resolve(here, '..'); // .../guide-sdk/src

/** The couplings the engine must never re-acquire (dec-5). Matched as the SOURCE
 *  of a static `import`/`export ... from` or a dynamic `import()` — so a bare
 *  substring elsewhere (a comment, a string) never trips a false positive. */
const FORBIDDEN = ['react-router', 'react-router-dom', '@memex/shared'];

/** Find every static/dynamic import whose module specifier is (or is under) a
 *  forbidden package. Returns the offending specifiers; empty = clean. */
export function findForbiddenImports(source: string): string[] {
  const hits: string[] = [];
  // import ... from 'x'  |  export ... from 'x'  |  import('x')  |  require('x')
  const re = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const spec = m[1];
    if (FORBIDDEN.some((p) => spec === p || spec.startsWith(`${p}/`))) hits.push(spec);
  }
  return hits;
}

function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkTsFiles(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('spec-222 t-2: guide-sdk dependency cut (ac-9)', () => {
  it('no engine source statically imports react-router* or @memex/shared', () => {
    tagAc(AC_9);
    const offenders: Record<string, string[]> = {};
    for (const file of walkTsFiles(SDK_SRC)) {
      // Skip this guard file itself — it names the forbidden packages as data.
      if (file === fileURLToPath(import.meta.url)) continue;
      const hits = findForbiddenImports(readFileSync(file, 'utf8'));
      if (hits.length) offenders[relative(SDK_SRC, file)] = hits;
    }
    expect(offenders).toEqual({});
  });

  it('the guard actually detects a violation (so a real regression would fail CI)', () => {
    tagAc(AC_9);
    // Positive control: the scanner must catch each forbidden form. If this ever
    // returns clean, the guard above is toothless and ac-9 is unenforced.
    expect(findForbiddenImports(`import { navigate } from 'react-router-dom';`)).toContain(
      'react-router-dom',
    );
    expect(findForbiddenImports(`import { resolveScreenKey } from '@memex/shared';`)).toContain(
      '@memex/shared',
    );
    expect(findForbiddenImports(`const x = await import('react-router');`)).toContain(
      'react-router',
    );
    // And it must NOT flag legitimate engine deps.
    expect(findForbiddenImports(`import { StateGraph } from '@langchain/langgraph';`)).toEqual([]);
    expect(findForbiddenImports(`import { Specky } from '../components/Specky';`)).toEqual([]);
  });
});
