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

// The ANIMATED Specky (idle bob/sway/blink loop) — its animation is CSS
// keyframes INSIDE the SVG, which play in an <img> context, so the no-React
// loader gets the same living mark the engine renders. The static frame made
// the first paint look dead next to the engine's idle icon.
import speckyAnimated from '../assets/specky.svg';
import { staticSiteNavigation } from '../navigation/staticSiteNavigation';
import type { GuideBundleConfig, MountedEngine } from './types';

/** The doorway's host element id (so a double-init can't stack two doorways). */
const HOST_ID = 'memex-guide-host';
/** Intrinsic aspect ratio of specky.svg (viewBox "0 0 240 330"). */
const SPECKY_ASPECT = 330 / 240;
/**
 * DOORWAY PARITY CONTRACT (see doorwayParity.test.ts): the doorway is the
 * loader's no-React replica of the engine's idle affordance — VoiceIcon
 * (a 64px `h-16 w-16 rounded-full` circle, painted by DOORWAY_CSS below) with
 * `mark={<Specky size={40} />}` — so the engine taking over on first click (and
 * a session ending later) is visually seamless. MARK_PX pins the mark width to
 * the engine idle branch's Specky size.
 */
const MARK_PX = 40; // engine.tsx idle branch: <Specky size={40} />

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
  img.src = speckyAnimated;
  img.alt = '';
  img.width = MARK_PX;
  img.height = Math.round(MARK_PX * SPECKY_ASPECT);
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
      // mountEngine is async (it mints the anon session token before starting).
      // spec-264 t-1 (dec-1): hand off WITHOUT a flicker. The doorway is hidden ONLY
      // from `onFirstPaint` — fired once the engine has committed its first frame, so
      // its idle Specky icon is already on screen. Hiding the doorway before this (the
      // old behaviour) left an empty frame between "doorway gone" and "engine painted".
      engine = await mountEngine({
        shadow,
        config,
        onFirstPaint: () => {
          doorway.style.display = 'none';
        },
      });
    } finally {
      loading = false;
      doorway.removeAttribute('data-guide-loading');
    }
  };
  doorway.addEventListener('click', () => void onFirstClick());

  // spec-264 t-3 (dec-3): first-load "Click me to ask anything" hint, shown once per
  // browser session (sessionStorage), auto-dismissed after 10s and on first click.
  maybeShowHintBubble(shadow, doorway);

  return host;
}

/** sessionStorage key for the once-per-session first-load hint (spec-264 dec-3). */
const HINT_SHOWN_KEY = 'memex-guide-hint-shown';
/** How long the hint stays before auto-dismissing (dec-3: 10 seconds). */
const HINT_TIMEOUT_MS = 10_000;

/**
 * Has the hint already been shown this browser session? Reads sessionStorage —
 * chosen (dec-3) because it survives in-tab page navigation on the multi-page
 * mindset-website (so the hint never re-nags as a visitor browses) yet re-appears in
 * a fresh tab / after the tab closes. A throwing/disabled store (private mode,
 * sandboxed iframe) DEGRADES TO "already shown" so we quietly skip the hint rather
 * than crash the loader — never showing twice is the safe failure.
 */
function hintAlreadyShown(): boolean {
  try {
    return window.sessionStorage.getItem(HINT_SHOWN_KEY) !== null;
  } catch {
    return true;
  }
}

/** Mark the hint shown for this session (best-effort; a throwing store is ignored). */
function markHintShown(): void {
  try {
    window.sessionStorage.setItem(HINT_SHOWN_KEY, '1');
  } catch {
    /* storage disabled — the hint simply isn't suppressed across reloads */
  }
}

/**
 * Render the first-load hint bubble into the shadow root, anchored above the doorway
 * (spec-264 t-3 / dec-3). Shows ONLY on the first init of a browser session; sets the
 * session flag immediately so a per-page SDK remount (multi-page site) does not
 * re-show it. Dismisses after HINT_TIMEOUT_MS, and immediately on the first doorway
 * click. No-op when already shown this session (or when storage is unavailable).
 */
function maybeShowHintBubble(shadow: ShadowRoot, doorway: HTMLElement): void {
  if (hintAlreadyShown()) return;
  markHintShown();

  const bubble = document.createElement('div');
  bubble.className = 'memex-guide-hint';
  bubble.setAttribute('data-guide-hint', '');
  bubble.setAttribute('role', 'status');
  bubble.textContent = 'Click me to ask anything';
  shadow.appendChild(bubble);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    if (timer !== undefined) clearTimeout(timer);
    doorway.removeEventListener('click', dismiss);
    bubble.remove();
  };
  timer = setTimeout(dismiss, HINT_TIMEOUT_MS);
  // Opening the chat kills the hint instantly (it has served its purpose).
  doorway.addEventListener('click', dismiss);
}

/**
 * The doorway's self-contained CSS (scoped to the shadow root).
 *
 * DOORWAY PARITY: these declarations are the plain-CSS translation of the
 * engine's idle VoiceIcon — `flex h-16 w-16 items-center justify-center
 * rounded-full bg-surface shadow-lg ring-1 ring-border transition
 * hover:scale-105` — as ENGINE_CSS (./engineStyles.ts) resolves those classes
 * inside the shadow root. The loader has no Tailwind and no token vars, so the
 * resolved values are hardcoded:
 *   - background #1b1e24  = bg-surface  (token --color-surface: 27 30 36; the
 *     engine always injects the DARK theme tokens on :host — not theme-aware)
 *   - ring hairline #3e4451 = ring-border (token --color-edge: 62 68 81),
 *     composed with shadow-lg exactly like ENGINE_CSS's `.ring-1.shadow-lg` rule
 *   - 64px circle = h-16/w-16 + rounded-full
 *   - transition  = ENGINE_CSS's `.transition` (150ms, same easing), transform-only
 * Position (fixed bottom/right 24px, z 2147483000) mirrors the engine's
 * ANCHOR_STYLE. Drift is guarded by doorwayParity.test.ts — keep them in sync.
 */
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
    height: 64px;
    width: 64px;
    padding: 0;
    border: none;
    border-radius: 9999px;
    background: #1b1e24;
    box-shadow:
      0 0 0 1px #3e4451,
      0 10px 15px -3px rgba(0, 0, 0, 0.35),
      0 4px 6px -4px rgba(0, 0, 0, 0.35);
    cursor: pointer;
    transition: transform 150ms cubic-bezier(0.4, 0, 0.2, 1);
  }
  .memex-guide-doorway:hover { transform: scale(1.05); }
  .memex-guide-doorway[data-guide-loading] { cursor: progress; opacity: 0.7; }
  .memex-guide-doorway img { display: block; pointer-events: none; }

  /* spec-264 t-3 (dec-3): the first-load hint — a yellow speech bubble sitting just
     above the 64px doorway (bottom 24px + 64px + an 12px gap = 100px), with a small
     downward tail pointing at it. ':host { all: initial }' wipes inherited type, so
     the font is declared explicitly. */
  .memex-guide-hint {
    position: fixed;
    right: 24px;
    bottom: 100px;
    z-index: 2147483000;
    max-width: 220px;
    padding: 8px 12px;
    border-radius: 10px;
    background: #fde047;
    color: #1b1e24;
    font: 500 14px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    box-shadow:
      0 10px 15px -3px rgba(0, 0, 0, 0.35),
      0 4px 6px -4px rgba(0, 0, 0, 0.35);
    cursor: default;
    animation: memex-guide-hint-in 200ms ease-out;
  }
  .memex-guide-hint::after {
    content: "";
    position: absolute;
    right: 22px;
    bottom: -5px;
    width: 11px;
    height: 11px;
    background: #fde047;
    transform: rotate(45deg);
    border-bottom-right-radius: 2px;
  }
  @keyframes memex-guide-hint-in {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }
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
