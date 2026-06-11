// spec-222 t-5 — ac-8 (build side): the bundle BUILD actually code-splits. After
// `build:bundle`, dist-bundle/ holds a THIN loader entry PLUS a SEPARATE, hashed
// engine chunk — proof the dynamic import('./engine') became its own lazily-fetched
// file rather than being inlined back into the loader.
//
// This reads the build output. If dist-bundle/ is absent (test run before the
// build), it runs `build:bundle` once so the assertion is self-contained.

import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tagAc } from '@memex-ai-ac/vitest';

const AC_8 = 'mindset-prod/memex-building-itself/specs/spec-222/acs/ac-8';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..', '..'); // .../packages/guide-sdk
const distBundle = join(pkgRoot, 'dist-bundle');

function ensureBuilt(): void {
  if (existsSync(join(distBundle, 'memex-guide.js'))) return;
  execSync('pnpm exec vite build --config vite.bundle.config.ts', {
    cwd: pkgRoot,
    stdio: 'ignore',
  });
}

describe('spec-222 t-5: bundle build code-splits the engine (ac-8)', () => {
  it('emits a thin loader entry + a SEPARATE engine chunk', () => {
    tagAc(AC_8);
    ensureBuilt();

    const files = readdirSync(distBundle);
    // The fixed-name loader entry...
    expect(files).toContain('memex-guide.js');
    // ...and a hashed engine chunk emitted from the dynamic import('./engine').
    const engineChunk = files.find((f) => /^engine-.*\.js$/.test(f));
    expect(engineChunk, `expected an engine-*.js chunk in ${files.join(', ')}`).toBeTruthy();

    const loaderBytes = statSync(join(distBundle, 'memex-guide.js')).size;
    const engineBytes = statSync(join(distBundle, engineChunk!)).size;

    // The loader is the SMALL thin entry; the engine is the heavy chunk. A regressed
    // build that inlined the engine would balloon the loader to engine size.
    expect(loaderBytes).toBeLessThan(50_000); // ~7KB in practice
    expect(engineBytes).toBeGreaterThan(loaderBytes * 5);

    // The loader does NOT contain the React engine inline — it must REFERENCE the
    // engine chunk by name (the dynamic import), and carry no createRoot.
    const loaderSrc = readFileSync(join(distBundle, 'memex-guide.js'), 'utf8');
    expect(loaderSrc).toContain(engineChunk!);
    expect(loaderSrc).not.toContain('createRoot');

    // The React/engine code lives in the engine chunk (or a shared chunk it pulls
    // in) — never in the loader. Confirm the loader doesn't statically reference
    // the shared vendor chunk either (so initial load fetches ONLY the loader).
    const sharedChunk = files.find((f) => /^index-.*\.js$/.test(f));
    if (sharedChunk) {
      expect(loaderSrc).not.toContain(sharedChunk);
    }
  });
});
