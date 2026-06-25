// spec-264 t-3 (dec-3) — the first-load "Click me to ask anything" hint. A yellow
// speech bubble anchored to the doorway, shown ONCE per browser session, auto-
// dismissed after 10s and on the first doorway click. "Once per session" is backed
// by sessionStorage (dec-3): it survives in-tab page navigation on the multi-page
// mindset-website (no re-nag while browsing) yet re-appears in a fresh tab. A
// throwing/disabled store must degrade to "don't show" rather than crash the loader.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import type { NavigationAdapter } from '../navigation/NavigationAdapter';

const SPEC = 'mindset-prod/memex-building-itself/specs/spec-264';
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

const HOST_ID = 'memex-guide-host';
const HINT_SEL = '[data-guide-hint]';

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
  surface: 'mindset-website',
  backend: 'https://memex.ai/guide/v1',
  navigation: fakeNavigation(),
  capabilities: {},
});

function freshDom() {
  document.body.innerHTML = '';
  document.getElementById(HOST_ID)?.remove();
}

describe('spec-264 t-3: first-load hint bubble (dec-3)', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    freshDom();
    window.sessionStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('renders the yellow "Click me to ask anything" bubble in the shadow root on first load (ac-3, ac-10)', async () => {
    tagAc(AC(3)); // scope: a yellow bubble appears on first load anchored to the launcher
    tagAc(AC(10)); // impl: renders on first load when the session flag is unset
    const { init } = await import('./loader');
    const host = init(cfg());
    const shadow = host.shadowRoot!;

    const hint = shadow.querySelector(HINT_SEL);
    expect(hint).not.toBeNull();
    expect(hint!.textContent).toBe('Click me to ask anything');
    // It lives in the shadow root, never the light DOM (host CSS can't reach it).
    expect(document.querySelector(HINT_SEL)).toBeNull();
    // Yellow treatment is defined in the shadow stylesheet.
    const style = shadow.querySelector('style')!;
    expect(style.textContent).toContain('.memex-guide-hint');
    expect(style.textContent).toContain('#fde047'); // the yellow background
    // Shown ⇒ the session flag is now set.
    expect(window.sessionStorage.getItem('memex-guide-hint-shown')).not.toBeNull();
  });

  it('does NOT re-show on a second init within the same session (multi-page remount) (ac-3, ac-11)', async () => {
    tagAc(AC(3));
    tagAc(AC(11)); // impl: once shown, the session flag suppresses it
    const { init } = await import('./loader');

    const first = init(cfg());
    expect(first.shadowRoot!.querySelector(HINT_SEL)).not.toBeNull();

    // Simulate a fresh page load in the SAME tab/session: new host, new shadow root,
    // but sessionStorage persists — the hint must not re-appear.
    freshDom();
    const second = init(cfg());
    expect(second.shadowRoot!.querySelector(HINT_SEL)).toBeNull();
  });

  it('auto-dismisses after 10 seconds (ac-11)', async () => {
    tagAc(AC(11));
    vi.useFakeTimers();
    const { init } = await import('./loader');
    const host = init(cfg());
    const shadow = host.shadowRoot!;
    expect(shadow.querySelector(HINT_SEL)).not.toBeNull();

    vi.advanceTimersByTime(9_999);
    expect(shadow.querySelector(HINT_SEL)).not.toBeNull(); // still up just before 10s
    vi.advanceTimersByTime(1);
    expect(shadow.querySelector(HINT_SEL)).toBeNull(); // gone at 10s
  });

  it('dismisses immediately when the doorway is clicked (ac-11)', async () => {
    tagAc(AC(11));
    // Mock the engine so the click doesn't drag in the real React engine chunk.
    vi.doMock('./engine', () => ({
      mountEngine: vi.fn((args: { onFirstPaint?: () => void }) => {
        args.onFirstPaint?.();
        return { unmount: vi.fn() };
      }),
    }));
    const { init } = await import('./loader');
    const host = init(cfg());
    const shadow = host.shadowRoot!;
    const doorway = shadow.querySelector<HTMLButtonElement>('[data-guide-doorway]')!;
    expect(shadow.querySelector(HINT_SEL)).not.toBeNull();

    doorway.click();
    expect(shadow.querySelector(HINT_SEL)).toBeNull(); // killed on open
  });

  it('a throwing/disabled sessionStorage degrades to "don\'t show" and never crashes the loader (ac-11)', async () => {
    tagAc(AC(11));
    // Private-mode / sandboxed iframe: storage access throws. Stub the whole global
    // (jsdom's sessionStorage methods sit behind a proxy, so spying on them is
    // unreliable — replacing the object is what a blocked store actually looks like).
    const throwingStorage = {
      getItem: () => {
        throw new Error('storage blocked');
      },
      setItem: () => {
        throw new Error('storage blocked');
      },
      removeItem: () => {},
      clear: () => {},
      key: () => null,
      length: 0,
    };
    vi.stubGlobal('sessionStorage', throwingStorage);

    const { init } = await import('./loader');
    // The loader must still mount the doorway, just without a hint.
    const host = init(cfg());
    const shadow = host.shadowRoot!;
    expect(shadow.querySelector('[data-guide-doorway]')).not.toBeNull();
    expect(shadow.querySelector(HINT_SEL)).toBeNull();
  });
});
