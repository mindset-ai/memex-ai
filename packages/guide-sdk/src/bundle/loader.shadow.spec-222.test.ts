// spec-222 t-5 — ac-7: the embeddable bundle mounts on a plain HTML page with ONE
// <script> include + ONE init() call, and ALL guide UI renders inside a shadow root
// so host-page CSS can't restyle it and the SDK's CSS doesn't leak to the host.
//
// "No bundler/build present" is satisfied structurally: this test imports the
// already-built loader MODULE and calls its global init() against a bare jsdom
// document — exactly what a static <script> + init() does. The doorway is rendered
// with NO React (the loader has no React import — proven by the ac-8 test).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import type { NavigationAdapter } from '../navigation/NavigationAdapter';

const AC_7 = 'mindset-prod/memex-building-itself/specs/spec-222/acs/ac-7';

/** A no-op navigation adapter standing in for staticSiteNavigation({...}). */
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

function freshDom() {
  document.body.innerHTML = '';
  document.getElementById(HOST_ID)?.remove();
}

describe('spec-222 t-5: embeddable bundle loader (ac-7)', () => {
  beforeEach(() => {
    vi.resetModules();
    freshDom();
  });

  it('importing the loader registers window.mindset.guide.init + .staticSiteNavigation', async () => {
    tagAc(AC_7);
    // Importing the module IS the <script> include — it self-registers the global.
    await import('./loader');
    expect(window.mindset).toBeDefined();
    expect(typeof window.mindset!.guide!.init).toBe('function');
    expect(typeof window.mindset!.guide!.staticSiteNavigation).toBe('function');
  });

  it('init({...}) creates a host element with an open shadow root', async () => {
    tagAc(AC_7);
    const { init } = await import('./loader');
    const host = init({
      surface: 'memex-website',
      backend: 'https://memex.ai/guide/v1',
      navigation: fakeNavigation(),
      capabilities: {},
    });
    // The host is appended to <body> and carries an OPEN shadow root (ac-7).
    expect(host.isConnected).toBe(true);
    expect(host.parentNode).toBe(document.body);
    expect(host.shadowRoot).not.toBeNull();
    expect(host.shadowRoot!.mode).toBe('open');
  });

  it('renders the at-rest Specky doorway INSIDE the shadow root, not the light DOM (ac-7)', async () => {
    tagAc(AC_7);
    const { init } = await import('./loader');
    const host = init({
      surface: 'memex-website',
      backend: 'https://memex.ai/guide/v1',
      navigation: fakeNavigation(),
      capabilities: {},
    });
    const shadow = host.shadowRoot!;

    // The Specky doorway lives in the SHADOW root...
    const doorwayInShadow = shadow.querySelector('[data-specky-doorway]');
    expect(doorwayInShadow).not.toBeNull();
    expect(doorwayInShadow!.tagName).toBe('IMG');
    // ...sourced from the bundler-resolved static-Specky SVG (never a web-root path).
    const src = doorwayInShadow!.getAttribute('src')!;
    expect(src.startsWith('data:image/svg+xml') || src.includes('/assets/')).toBe(true);

    // ...and is NOT in the light document (shadow isolation — host CSS can't reach it).
    expect(document.querySelector('[data-specky-doorway]')).toBeNull();
    // The clickable doorway button is likewise shadow-only.
    expect(shadow.querySelector('[data-guide-doorway]')).not.toBeNull();
    expect(document.querySelector('[data-guide-doorway]')).toBeNull();
  });

  it('the SDK injects its styles into the shadow root, not the host document (ac-7)', async () => {
    tagAc(AC_7);
    const { init } = await import('./loader');
    const host = init({
      surface: 'memex-website',
      backend: 'https://memex.ai/guide/v1',
      navigation: fakeNavigation(),
      capabilities: {},
    });
    // The doorway's stylesheet is a <style> INSIDE the shadow root...
    const shadowStyle = host.shadowRoot!.querySelector('style');
    expect(shadowStyle).not.toBeNull();
    expect(shadowStyle!.textContent).toContain('memex-guide-doorway');
    // ...and the loader added NO <style> to the host <head> (no CSS leak).
    const leaked = Array.from(document.head.querySelectorAll('style')).filter((s) =>
      (s.textContent ?? '').includes('memex-guide-doorway'),
    );
    expect(leaked).toHaveLength(0);
  });

  it('init() is idempotent — a second call reuses the single host (no stacked doorways)', async () => {
    tagAc(AC_7);
    const { init } = await import('./loader');
    const cfg = {
      surface: 'memex-website',
      backend: 'https://memex.ai/guide/v1',
      navigation: fakeNavigation(),
      capabilities: {},
    };
    const a = init(cfg);
    const b = init(cfg);
    expect(b).toBe(a);
    expect(document.querySelectorAll(`#${HOST_ID}`)).toHaveLength(1);
  });
});
