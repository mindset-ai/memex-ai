// spec-264 t-1 (dec-1) — the launcher→chat hand-off must not flicker. The thin
// pre-React doorway is removed ONLY once the lazily-loaded engine commits its first
// frame (its idle Specky icon is on screen), so there is never a paint with no
// Specky affordance. Before this fix the loader hid the doorway the instant the
// engine chunk's dynamic import resolved — i.e. BEFORE React mounted — leaving an
// empty frame (the visible "disappears for a second" flicker).
//
// The mock engine here lets the test hold `onFirstPaint` and fire it on demand, so
// it can assert the ordering: doorway still visible after mountEngine resolves, and
// hidden only after the first-paint signal.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import type { NavigationAdapter } from '../navigation/NavigationAdapter';

const SPEC = 'mindset-prod/memex-building-itself/specs/spec-264';
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

const HOST_ID = 'memex-guide-host';

function fakeNavigation(): NavigationAdapter {
  return {
    resolveScreenKey: () => 'home',
    currentScreenKey: () => 'home',
    navigate: () => ({ ok: true, path: '/' }),
    findElement: () => null,
    elementsForScreen: () => [],
  };
}

const cfg = () => ({
  surface: 'memex-website',
  backend: 'https://memex.ai/guide/v1',
  navigation: fakeNavigation(),
  capabilities: {},
});

describe('spec-264 t-1: launcher→chat hand-off does not flicker (dec-1)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    document.getElementById(HOST_ID)?.remove();
    try {
      window.sessionStorage.clear();
    } catch {
      /* ignore */
    }
  });

  it('keeps the doorway visible until the engine signals first paint, then hands off (ac-1, ac-6)', async () => {
    tagAc(AC(1)); // scope: never a frame with no Specky affordance on screen
    tagAc(AC(6)); // impl: doorway removed only after the first-paint signal

    // Capture the loader's onFirstPaint instead of firing it, so we control timing.
    let capturedOnFirstPaint: (() => void) | undefined;
    const mountEngine = vi.fn((args: { onFirstPaint?: () => void }) => {
      capturedOnFirstPaint = args.onFirstPaint;
      return { unmount: vi.fn() };
    });
    vi.doMock('./engine', () => ({ mountEngine }));

    const { init } = await import('./loader');
    const host = init(cfg());
    const doorway = host.shadowRoot!.querySelector<HTMLButtonElement>('[data-guide-doorway]')!;

    doorway.click();
    await vi.waitFor(() => expect(mountEngine).toHaveBeenCalledTimes(1));

    // The engine has mounted but NOT yet painted → the doorway is STILL visible.
    // (Hiding it here is exactly the old flicker.)
    expect(capturedOnFirstPaint).toBeTypeOf('function');
    expect(doorway.style.display).not.toBe('none');

    // The engine commits its first frame → only NOW does the doorway hand off.
    capturedOnFirstPaint!();
    expect(doorway.style.display).toBe('none');
  });

  it('still loads the engine ONLY on first click — React is not on the initial paint path (ac-7)', async () => {
    tagAc(AC(7)); // impl: engine imported only on click; lazy-load preserved
    const mountEngine = vi.fn((args: { onFirstPaint?: () => void }) => {
      args.onFirstPaint?.();
      return { unmount: vi.fn() };
    });
    vi.doMock('./engine', () => ({ mountEngine }));

    const { init } = await import('./loader');
    const host = init(cfg());

    // After init(): the doorway is present and the engine has NOT been mounted.
    expect(mountEngine).not.toHaveBeenCalled();
    const doorway = host.shadowRoot!.querySelector<HTMLButtonElement>('[data-guide-doorway]')!;
    expect(doorway).not.toBeNull();

    // First click crosses the lazy boundary → the engine mounts, then hands off.
    doorway.click();
    await vi.waitFor(() => expect(mountEngine).toHaveBeenCalledTimes(1));
    expect(doorway.style.display).toBe('none');
  });
});
