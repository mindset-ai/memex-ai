// spec-222 t-3 (dec-2) — verifies the built-in static-site NavigationAdapter:
// pathname→screen-key resolution, in-page scroll/anchor, cross-page navigation,
// light-DOM element finding, all driven by a config-data registry. (ac-10)

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { staticSiteNavigation, type StaticScreen } from './staticSiteNavigation';

const AC_10 = 'mindset-prod/memex-building-itself/specs/spec-222/acs/ac-10';
const AC_3 = 'mindset-prod/memex-building-itself/specs/spec-222/acs/ac-3';
const AC_22 = 'mindset-prod/memex-building-itself/specs/spec-222/acs/ac-22';

const SCREENS: StaticScreen[] = [
  { key: 'home', path: '/', elements: [{ id: 'hero', description: 'the hero pitch' }] },
  { key: 'pricing', path: '/', sectionId: 'pricing-section', elements: [{ id: 'pricing-section', description: 'pricing' }] },
  { key: 'docs', path: '/docs.html', elements: [{ id: 'docs-intro', description: 'docs intro' }] },
  { key: 'story', path: '/story.html' },
];

/** A static adapter wired with injected seams so nothing actually navigates. */
function makeAdapter(pathname: string) {
  const performPageLoad = vi.fn();
  const scrollToElement = vi.fn();
  const adapter = staticSiteNavigation({
    screens: SCREENS,
    getLocation: () => ({ pathname }),
    performPageLoad,
    scrollToElement,
  });
  return { adapter, performPageLoad, scrollToElement };
}

describe('spec-222 t-3: staticSiteNavigation (ac-10)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('resolves a screen key from location.pathname (config-data registry)', () => {
    tagAc(AC_10);
    expect(makeAdapter('/').adapter.resolveScreenKey()).toBe('home');
    expect(makeAdapter('/index.html').adapter.resolveScreenKey()).toBe('home'); // normalised
    expect(makeAdapter('/docs.html').adapter.resolveScreenKey()).toBe('docs');
    expect(makeAdapter('/story.html').adapter.resolveScreenKey()).toBe('story');
    expect(makeAdapter('/nope.html').adapter.resolveScreenKey()).toBeNull();
    // currentScreenKey() mirrors resolveScreenKey() against the live location.
    expect(makeAdapter('/docs.html').adapter.currentScreenKey()).toBe('docs');
  });

  it('scrolls/anchors to an in-page section IMMEDIATELY, without a page load (ac-10/ac-22)', () => {
    tagAc(AC_10);
    tagAc(AC_22); // non-destructive tools (in-page scroll) still fire immediately
    document.body.innerHTML = `<section data-guide-id="pricing-section">Pricing</section>`;
    const { adapter, performPageLoad, scrollToElement } = makeAdapter('/'); // already on '/'
    const outcome = adapter.navigate('pricing'); // pricing is an in-page section of '/'
    expect(outcome).toEqual({ ok: true, path: '#pricing-section' });
    expect(scrollToElement).toHaveBeenCalledTimes(1);
    expect(performPageLoad).not.toHaveBeenCalled(); // in-page = no reload
  });

  it('DEFERS a destructive cross-page navigate: queued on navigate(), flushed on onPlaybackDrained (ac-22)', () => {
    tagAc(AC_10); // it does navigate across pages...
    tagAc(AC_22); // ...but the page-turn is DEFERRED, never synchronous in graph.invoke
    const cue = vi.fn();
    const performPageLoad = vi.fn();
    const scrollToElement = vi.fn();
    const adapter = staticSiteNavigation({
      screens: SCREENS,
      getLocation: () => ({ pathname: '/' }), // currently on home
      performPageLoad,
      scrollToElement,
      onCrossPageQueued: cue,
    });
    const outcome = adapter.navigate('docs'); // docs lives on /docs.html → cross-page
    // tool_result stays 'executed' (the engine's contract) — we control only timing.
    expect(outcome).toEqual({ ok: true, path: '/docs.html' });
    expect(performPageLoad).not.toHaveBeenCalled(); // NOT executed synchronously
    expect(cue).toHaveBeenCalledWith('/docs.html'); // earcon/visual cue fired on queue
    expect(scrollToElement).not.toHaveBeenCalled();

    // The spoken turn finishes PLAYING → the engine calls the drain hook → page turns.
    adapter.onPlaybackDrained!();
    expect(performPageLoad).toHaveBeenCalledExactlyOnceWith('/docs.html');
  });

  it('onPlaybackDrained is a no-op when nothing is queued, and never double-fires', () => {
    tagAc(AC_22);
    const performPageLoad = vi.fn();
    const adapter = staticSiteNavigation({
      screens: SCREENS,
      getLocation: () => ({ pathname: '/' }),
      performPageLoad,
    });
    adapter.onPlaybackDrained!(); // nothing queued
    expect(performPageLoad).not.toHaveBeenCalled();
    adapter.navigate('docs'); // queue one
    adapter.onPlaybackDrained!(); // flush
    adapter.onPlaybackDrained!(); // a second drain must not re-navigate
    expect(performPageLoad).toHaveBeenCalledExactlyOnceWith('/docs.html');
  });

  it('rejects an unregistered screen without navigating', () => {
    tagAc(AC_10);
    const { adapter, performPageLoad } = makeAdapter('/');
    expect(adapter.navigate('does-not-exist')).toEqual({ ok: false, reason: 'not a navigable screen' });
    expect(performPageLoad).not.toHaveBeenCalled();
  });

  it('the website static-page adapter satisfies the host-supplied NavigationAdapter contract (ac-3)', () => {
    tagAc(AC_3);
    // ac-3: navigation is injected, not hardcoded — the website supplies a
    // static-page adapter (here) and the app supplies its router-backed one
    // (packages/ui/src/voice/reactRouterNavigationAdapter.ts). Both implement the
    // same engine-facing seam; the engine depends on neither concrete host.
    const { adapter } = makeAdapter('/');
    for (const method of ['resolveScreenKey', 'currentScreenKey', 'navigate', 'findElement'] as const) {
      expect(typeof adapter[method]).toBe('function');
    }
    // It is a plain config-data-driven object — no react-router, no @memex/shared
    // (enforced structurally by the ac-9 dependency-cut guard).
    expect(adapter.navigate('home').ok).toBe(true);
  });

  it('findElement resolves the host light DOM via [data-guide-id]; elementsForScreen returns config-data', () => {
    tagAc(AC_10);
    document.body.innerHTML = `<div data-guide-id="docs-intro">intro</div>`;
    const { adapter } = makeAdapter('/docs.html');
    expect(adapter.findElement('docs-intro')?.textContent).toBe('intro');
    expect(adapter.findElement('absent')).toBeNull();
    expect(adapter.elementsForScreen('docs')).toEqual([{ id: 'docs-intro', description: 'docs intro' }]);
    expect(adapter.elementsForScreen(null)).toEqual([]);
  });
});
