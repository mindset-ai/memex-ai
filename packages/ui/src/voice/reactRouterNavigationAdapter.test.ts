// spec-222 / spec-190 t-4 (ac-16) — the app-side NavigationAdapter test. The
// engine's screen-key resolution + the UI data-guide-id consistency scan moved
// here (out of guide-sdk's guideElements.test) along with their `@memex/shared`
// coupling (ac-9): guide-sdk owns the pure DOM resolver; the app owns route ↔
// registry resolution. Same assertions + the same AC16 tag, now exercising the
// react-router-backed adapter the app injects into the engine.

import { describe, it, expect, afterEach } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { allGuideElementIds } from '@memex/shared';
import { createReactRouterNavigationAdapter } from './reactRouterNavigationAdapter';

const AC16 = 'mindset-prod/memex-building-itself/specs/spec-190/acs/ac-16';
const AC22 = 'mindset-prod/memex-building-itself/specs/spec-222/acs/ac-22';

function adapter() {
  return createReactRouterNavigationAdapter({
    navigate: () => {},
    namespace: 'acme',
    memex: 'team',
  });
}

describe('adapter.resolveScreenKey (ac-16 — router path → screenKey)', () => {
  it('derives the screen key from a pathname via the registry mapping', () => {
    const a = adapter();
    expect(a.resolveScreenKey({ pathname: '/acme/team/specs/spec-12' })).toBe('spec-detail');
    expect(a.resolveScreenKey({ pathname: '/acme/team/standards' })).toBe('standards-list');
    expect(a.resolveScreenKey({ pathname: '/login' })).toBeNull();
  });
});

describe('adapter.findElement (ac-16 — id → live DOM node)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('resolves a registry id to the node carrying its data-guide-id', () => {
    document.body.innerHTML =
      '<div><button data-guide-id="new-spec-button">+ New Spec</button></div>';
    const node = adapter().findElement('new-spec-button');
    expect(node).not.toBeNull();
    expect(node?.tagName).toBe('BUTTON');
  });

  it('returns null when the element is not currently rendered', () => {
    document.body.innerHTML = '<div>no targets here</div>';
    expect(adapter().findElement('phase-pill')).toBeNull();
  });
});

describe('adapter.navigate (ac-16 — validate-then-navigate)', () => {
  it('resolves a navigable screen to a tenant-scoped path, rejects unnavigable', () => {
    const calls: string[] = [];
    const a = createReactRouterNavigationAdapter({
      navigate: (p) => calls.push(p),
      namespace: 'acme',
      memex: 'team',
    });
    expect(a.navigate('standards-list')).toEqual({ ok: true, path: '/acme/team/standards' });
    expect(calls).toEqual(['/acme/team/standards']);
    // Detail-only / unregistered destinations are refused WITHOUT navigating.
    expect(a.navigate('spec-detail').ok).toBe(false);
    expect(a.navigate('not-a-screen').ok).toBe(false);
    expect(calls).toEqual(['/acme/team/standards']); // no further navigation
  });

  it('navigates IMMEDIATELY (soft-nav) — the app adapter defines no deferral hook (spec-222 ac-22)', () => {
    tagAc(AC22);
    // ac-22: the Memex app's adapter keeps executing navigate immediately, in
    // contrast to the website's staticSiteNavigation which DEFERS a destructive
    // cross-page turn to onPlaybackDrained. The app is an SPA — react-router
    // soft-nav is non-destructive, so the page-turn happens synchronously here and
    // the adapter intentionally exposes NO onPlaybackDrained hook to defer to.
    const calls: string[] = [];
    const a = createReactRouterNavigationAdapter({
      navigate: (p) => calls.push(p),
      namespace: 'acme',
      memex: 'team',
    });
    a.navigate('standards-list');
    expect(calls).toEqual(['/acme/team/standards']); // executed synchronously, not queued
    expect(a.onPlaybackDrained).toBeUndefined(); // no deferral seam → immediate soft-nav
  });
});

describe('data-guide-id consistency (ac-16 — components match registry ids)', () => {
  it('every data-guide-id wired into the UI is a registered element id', () => {
    const uiSrc = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const known = new Set(allGuideElementIds());
    const found: Array<{ id: string; file: string }> = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === 'node_modules') continue;
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.(tsx?|jsx?)$/.test(entry) || /\.test\./.test(entry)) continue;
        const text = readFileSync(full, 'utf8');
        for (const m of text.matchAll(/data-guide-id="([a-z0-9-]+)"/g)) {
          found.push({ id: m[1], file: full });
        }
      }
    };
    walk(uiSrc);

    // There is at least one wired target (the New Spec button), and none dangle.
    expect(found.length).toBeGreaterThan(0);
    const dangling = found.filter((f) => !known.has(f.id));
    expect(dangling, `dangling data-guide-id(s): ${JSON.stringify(dangling)}`).toEqual([]);
    tagAc(AC16);
  });
});
