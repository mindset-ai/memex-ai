// spec-222 t-5 — ac-8: the voice engine is LAZY-loaded. The initial script is a
// thin loader; the full engine/React bundle is fetched ONLY on the first Specky
// interaction — a visitor who never invokes the guide downloads no engine bundle.
//
// Two complementary guards (either alone is gameable; together they catch a real
// regression):
//   (a) STRUCTURAL — scan loader.ts's own source: it must NOT statically import
//       ./engine, react, or react-dom; the ONLY path to the engine is a DYNAMIC
//       `import('./engine')`. A static import creeping in fails this.
//   (b) BEHAVIOURAL — mock ./engine so its mountEngine is a spy: after init() it is
//       NOT called (engine not loaded on mount), and it IS called on the first
//       doorway click. A static import would also pull the engine in eagerly and
//       (in this mock) still not call mountEngine on mount — so (a) covers the
//       eager-fetch regression and (b) covers the on-click handoff.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NavigationAdapter } from '../navigation/NavigationAdapter';

const AC_8 = 'mindset-prod/memex-building-itself/specs/spec-222/acs/ac-8';

const here = dirname(fileURLToPath(import.meta.url));
const LOADER_SRC = resolve(here, 'loader.ts');

function fakeNavigation(): NavigationAdapter {
  return {
    resolveScreenKey: () => 'home',
    currentScreenKey: () => 'home',
    navigate: () => ({ ok: true, path: '/' }),
    findElement: () => null,
    elementsForScreen: () => [],
  };
}

const HOST_ID = 'memex-guide-host';

/** Extract module specifiers of STATIC import/export-from statements (not dynamic
 *  import() calls, which are `import(...)` with a paren). */
function staticImportSpecifiers(source: string): string[] {
  const specs: string[] = [];
  // `import ... from 'x'` and `import 'x'` and `export ... from 'x'` — but NOT
  // `import('x')` (the leading `(` after import means a dynamic import).
  const re = /(?:^|[\s;])(?:import|export)\b(?!\s*\()[^'"\n]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;])import\s+['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    specs.push((m[1] ?? m[2])!);
  }
  return specs;
}

describe('spec-222 t-5: engine is lazy-loaded (ac-8)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    document.getElementById(HOST_ID)?.remove();
  });

  it('(a) structural: loader.ts has NO static import of the engine/React — only a dynamic import(\'./engine\')', () => {
    tagAc(AC_8);
    const src = readFileSync(LOADER_SRC, 'utf8');

    const staticSpecs = staticImportSpecifiers(src);
    // The thin loader must not statically pull in the heavy engine or React.
    expect(staticSpecs).not.toContain('./engine');
    expect(staticSpecs).not.toContain('react');
    expect(staticSpecs).not.toContain('react-dom');
    expect(staticSpecs).not.toContain('react-dom/client');
    // None of the static specifiers may even mention react / engine.
    for (const spec of staticSpecs) {
      expect(spec).not.toMatch(/(^|\/)react(-dom)?($|\/)/);
      expect(spec).not.toContain('engine');
    }

    // The ONLY path to the engine is a dynamic import. Prove that form is present.
    expect(src).toMatch(/import\(\s*['"]\.\/engine['"]\s*\)/);

    // Sanity: our scanner DOES see the legitimate static imports the loader keeps
    // (so a green result above isn't a parser miss). The svg + the nav adapter
    // + the type module are all static and engine-free.
    expect(staticSpecs).toContain('../assets/specky-static.svg');
    expect(staticSpecs).toContain('../navigation/staticSiteNavigation');
  });

  it('(b) behavioural: the engine is NOT loaded by init(); it loads on the FIRST doorway click', async () => {
    tagAc(AC_8);

    // Mock the engine module so we can observe exactly when it is pulled in.
    const mountEngine = vi.fn(() => ({ unmount: vi.fn() }));
    vi.doMock('./engine', () => ({ mountEngine }));

    const { init } = await import('./loader');
    const host = init({
      surface: 'memex-website',
      backend: 'https://memex.ai/guide/v1',
      navigation: fakeNavigation(),
      capabilities: {},
    });

    // After init(): the doorway exists but the engine has NOT been mounted — a
    // visitor who never clicks gets no engine.
    expect(mountEngine).not.toHaveBeenCalled();
    const doorway = host.shadowRoot!.querySelector<HTMLButtonElement>('[data-guide-doorway]');
    expect(doorway).not.toBeNull();

    // First click crosses the lazy boundary → the engine chunk's mountEngine runs.
    doorway!.click();
    // The dynamic import resolves on a microtask; flush it.
    await vi.waitFor(() => expect(mountEngine).toHaveBeenCalledTimes(1));

    // It is handed the SAME shadow root + the init config (so the engine mounts
    // into the isolated tree — ac-7) — and the doorway hands off (hidden).
    const arg = mountEngine.mock.calls[0][0] as { shadow: ShadowRoot; config: { backend: string } };
    expect(arg.shadow).toBe(host.shadowRoot);
    expect(arg.config.backend).toBe('https://memex.ai/guide/v1');
    expect(doorway!.style.display).toBe('none');
  });

  it('(b) the engine loads at most once — repeated clicks do not re-import it', async () => {
    tagAc(AC_8);
    const mountEngine = vi.fn(() => ({ unmount: vi.fn() }));
    vi.doMock('./engine', () => ({ mountEngine }));

    const { init } = await import('./loader');
    const host = init({
      surface: 'memex-website',
      backend: 'https://memex.ai/guide/v1',
      navigation: fakeNavigation(),
      capabilities: {},
    });
    const doorway = host.shadowRoot!.querySelector<HTMLButtonElement>('[data-guide-doorway]')!;

    doorway.click();
    await vi.waitFor(() => expect(mountEngine).toHaveBeenCalledTimes(1));
    // A second click after hand-off must not re-mount the engine.
    doorway.click();
    await Promise.resolve();
    expect(mountEngine).toHaveBeenCalledTimes(1);
  });

  it('the scanner is sound: it flags a static engine/React import (so a regression would fail)', () => {
    tagAc(AC_8);
    // Positive control — if the loader regressed to a static engine import, the
    // structural guard above must catch it.
    expect(staticImportSpecifiers(`import { mountEngine } from './engine';`)).toContain('./engine');
    expect(staticImportSpecifiers(`import { createRoot } from 'react-dom/client';`)).toContain(
      'react-dom/client',
    );
    expect(staticImportSpecifiers(`import * as React from 'react';`)).toContain('react');
    // And it must NOT mistake a dynamic import for a static one.
    expect(staticImportSpecifiers(`const m = await import('./engine');`)).not.toContain('./engine');
  });
});
