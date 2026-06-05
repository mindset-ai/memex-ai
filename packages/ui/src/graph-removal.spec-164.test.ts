import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tagAc } from '@memex-ai-ac/vitest';

// spec-164 dec-2 / ac-16 — the t-19 graph view is gone for good: no TaskGraph
// component, no @xyflow/react dependency, no lingering import anywhere in the
// UI source tree. Source-level assertions so a reintroduction (or a leftover
// import that would crash the build) fails loudly here.

const AC_DEP_REMOVED = 'mindset-prod/memex-building-itself/specs/spec-164/acs/ac-16';

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const UI_ROOT = join(SRC_DIR, '..');

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue;
      yield* walk(full);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      yield full;
    }
  }
}

describe('graph removal (spec-164 dec-2)', () => {
  it('@xyflow/react is no longer a dependency of packages/ui', () => {
    tagAc(AC_DEP_REMOVED);
    const pkg = JSON.parse(readFileSync(join(UI_ROOT, 'package.json'), 'utf8'));
    expect(pkg.dependencies?.['@xyflow/react']).toBeUndefined();
    expect(pkg.devDependencies?.['@xyflow/react']).toBeUndefined();
  });

  it('no source file imports @xyflow/react or TaskGraph', () => {
    tagAc(AC_DEP_REMOVED);
    expect(existsSync(join(SRC_DIR, 'components', 'TaskGraph.tsx'))).toBe(false);
    const offenders: string[] = [];
    for (const file of walk(SRC_DIR)) {
      if (file === fileURLToPath(import.meta.url)) continue;
      const body = readFileSync(file, 'utf8');
      if (body.includes('@xyflow/react') || /from '.*TaskGraph'/.test(body)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
