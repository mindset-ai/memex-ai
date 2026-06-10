// spec-222 t-5 (dec-1 / ac-7 / ac-8) — the embeddable SDK bundle's THIN LOADER.
//
// This is the bundle entry a plain static HTML page drops in with ONE script tag
// plus ONE init call (no build step on the site):
//
//   <script type="module" src="/js/memex-guide.js"></script>
//   <script type="module">
//     window.mindset.guide.init({
//       surface: 'memex-website',
//       backend: 'https://memex.ai/guide/v1',
//       navigation: window.mindset.guide.staticSiteNavigation({ screens: [...] }),
//       capabilities: {},            // website: walkthrough OFF
//     });
//   </script>
//
// LAZY-LOAD CONTRACT (ac-8): this module must stay tiny. It registers the global,
// renders ONLY the at-rest Specky doorway (an <img> from the static SVG URL — NO
// React, NO orchestrator, NO heavy engine), and on the FIRST doorway click it
// `await import('./engine')` — a DYNAMIC import Vite code-splits into a SEPARATE
// chunk that a visitor who never clicks never downloads. There is therefore NO
// static import of './engine', React, or the orchestrator anywhere below; the
// engine dependency-cut guard for this file is the ac-8 structural test.

import speckyStatic from '../assets/specky-static.svg';
import { staticSiteNavigation } from '../navigation/staticSiteNavigation';
import type { GuideBundleConfig, MountedEngine } from './types';

/** The doorway's host element id (so a double-init can't stack two doorways). */
const HOST_ID = 'memex-guide-host';
/** Intrinsic aspect ratio of specky-static.svg (viewBox "0 0 240 330"). */
const SPECKY_ASPECT = 330 / 240;
const DOORWAY_PX = 56;

/**
 * Mount the guide on a plain HTML page (ac-7). Creates a host element appended to
 * <body>, attaches an OPEN shadow root (all guide UI lives inside it so host CSS
 * can't restyle the guide and the guide's CSS can't leak), and renders the at-rest
 * Specky doorway. The heavy engine is NOT loaded here — only on first click (ac-8).
 *
 * Returns the host element (mainly for tests / programmatic teardown).
 */
export function init(config: GuideBundleConfig): HTMLElement {
  if (typeof document === 'undefined') {
    throw new Error('[memex-guide] init() requires a DOM (browser) environment');
  }

  // Idempotent: a second init() reuses the existing host rather than stacking.
  const existing = document.getElementById(HOST_ID);
  if (existing) return existing;

  const host = document.createElement('div');
  host.id = HOST_ID;
  // The host itself is a zero-size anchor; the doorway positions itself fixed.
  host.setAttribute('data-memex-guide', 'doorway');
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });

  // Base styling for the doorway lives INSIDE the shadow root (never the host
  // document) so it neither leaks out nor is restyled by the host page (ac-7).
  const style = document.createElement('style');
  style.textContent = DOORWAY_CSS;
  shadow.appendChild(style);

  const doorway = document.createElement('button');
  doorway.type = 'button';
  doorway.className = 'memex-guide-doorway';
  doorway.setAttribute('data-guide-doorway', '');
  doorway.setAttribute('aria-label', 'Ask Specky');
  doorway.title = 'Ask Specky';

  const img = document.createElement('img');
  img.src = speckyStatic;
  img.alt = '';
  img.width = DOORWAY_PX;
  img.height = Math.round(DOORWAY_PX * SPECKY_ASPECT);
  img.draggable = false;
  img.setAttribute('data-specky-doorway', '');
  doorway.appendChild(img);
  shadow.appendChild(doorway);

  // First click is the lazy boundary (ac-8): only NOW is the engine chunk fetched.
  let engine: MountedEngine | null = null;
  let loading = false;
  const onFirstClick = async () => {
    if (engine || loading) return;
    loading = true;
    doorway.setAttribute('data-guide-loading', '');
    try {
      // DYNAMIC import — Vite emits this as a SEPARATE chunk fetched on first
      // interaction. Keeping this the ONLY reference to ./engine is what makes the
      // initial loader thin (ac-8). Do NOT convert this to a static import.
      const { mountEngine } = await import('./engine');
      // The doorway has done its job — the engine owns the affordance from here.
      doorway.style.display = 'none';
      // mountEngine is async (it mints the anon session token before starting).
      engine = await mountEngine({ shadow, config });
    } finally {
      loading = false;
      doorway.removeAttribute('data-guide-loading');
    }
  };
  doorway.addEventListener('click', () => void onFirstClick());

  return host;
}

/** The doorway's self-contained CSS (scoped to the shadow root). */
const DOORWAY_CSS = `
  :host { all: initial; }
  .memex-guide-doorway {
    position: fixed;
    bottom: 24px;
    right: 24px;
    z-index: 2147483000;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 6px;
    border: none;
    border-radius: 9999px;
    background: #ffffff;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
    cursor: pointer;
    transition: transform 120ms ease;
  }
  .memex-guide-doorway:hover { transform: scale(1.05); }
  .memex-guide-doorway[data-guide-loading] { cursor: progress; opacity: 0.7; }
  .memex-guide-doorway img { display: block; pointer-events: none; }
`;

// The global the static site calls. Registered eagerly on load (this is the whole
// public surface): `init` + the website's built-in `staticSiteNavigation` adapter
// (re-exported from its single source — the engine's existing implementation).
type GuideGlobal = {
  init: typeof init;
  staticSiteNavigation: typeof staticSiteNavigation;
};

declare global {
  interface Window {
    mindset?: { guide?: GuideGlobal } & Record<string, unknown>;
  }
}

const mindset = (window.mindset = window.mindset || {});
mindset.guide = { init, staticSiteNavigation };

export { staticSiteNavigation };
