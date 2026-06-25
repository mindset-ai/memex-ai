// spec-222 t-3 (dec-2) — the SDK's built-in NavigationAdapter for plain
// multi-page static sites (the marketing website: index.html, docs.html,
// story.html, writing/…). It satisfies the engine's navigation coupling without
// react-router or @memex/shared — everything is driven by a CONFIG-DATA registry
// the site author passes to `init()`.
//
// What it does (ac-10):
//   - resolveScreenKey(location) — maps location.pathname → a screen key.
//   - findElement(id)            — resolves a guide-element id against the HOST
//                                  page's LIGHT DOM ([data-guide-id], or a custom
//                                  selector). Guide UI itself lives in the SDK's
//                                  shadow DOM; the adapter straddles the boundary.
//   - navigate(target)           — IN-PAGE sections scroll/anchor immediately;
//                                  CROSS-PAGE targets resolve to an href.
//
// The cross-page EXECUTION TIMING is owned here (not the engine): t-4 wraps the
// cross-page branch so a destructive page-turn is DEFERRED until playback drains.
// For t-3 the cross-page branch performs the page load immediately; the seam
// (`performPageLoad`) is injectable so t-4 can swap in the deferred page-turn and
// so tests never trigger a real navigation.

import type { GuideElement, GuideLocation, NavigateOutcome, NavigationAdapter } from './NavigationAdapter';

/** One entry in the config-data screen registry. A "screen" is a page or an
 *  in-page section the guide can resolve, navigate to, and talk about. */
export interface StaticScreen {
  /** Stable screen key (matches the corpus/registry keys the model sees). */
  key: string;
  /** The page this screen lives on, e.g. '/' or '/docs.html'. Same-page targets
   *  (path === the current pathname) are treated as IN-PAGE. */
  path: string;
  /** Optional in-page anchor id (the [data-guide-id] / element id to scroll to
   *  when navigating to an in-page section). */
  sectionId?: string;
  /** The guide-navigable elements on this screen (config-data, dec-2). */
  elements?: GuideElement[];
}

export interface StaticSiteNavigationConfig {
  /** The screen registry — declarative config-data, authored by the site. */
  screens: StaticScreen[];
  /** Host selector for `findElement`. Default: `[data-guide-id="<id>"]`. */
  selectorFor?: (id: string) => string;
  /** Live location accessor (injectable for tests). Default: window.location. */
  getLocation?: () => GuideLocation;
  /** Execute a cross-page load (injectable for tests + for t-4's deferral).
   *  Default: assign window.location to the href. */
  performPageLoad?: (href: string) => void;
  /** Scroll an in-page element into view (injectable for tests). Default:
   *  el.scrollIntoView({ behavior:'smooth', block:'center' }). */
  scrollToElement?: (el: HTMLElement) => void;
  /** spec-222 dec-8 (t-4): a cue fired when a destructive cross-page turn is
   *  QUEUED (deferred until the spoken turn drains) — e.g. an earcon or a visual
   *  "Opening the docs for you…" flash. Receives the pending href. Default no-op. */
  onCrossPageQueued?: (href: string) => void;
}

const DEFAULT_SELECTOR = (id: string) => `[data-guide-id="${id}"]`;

function defaultGetLocation(): GuideLocation {
  return { pathname: typeof window !== 'undefined' ? window.location.pathname : '/' };
}

function defaultPerformPageLoad(href: string): void {
  if (typeof window !== 'undefined') window.location.assign(href);
}

function defaultScroll(el: HTMLElement): void {
  el.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
}

/** Normalise a pathname so '/', '/index.html', and '' compare equal. */
function normalisePath(path: string): string {
  let p = path || '/';
  p = p.replace(/\/index\.html$/, '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p || '/';
}

/**
 * Build the website's NavigationAdapter from a config-data registry (dec-2).
 * `window.mindset.guide.staticSiteNavigation(config)` (the global is wired by the
 * bundle, t-5); the function itself lives here so app + bundle share one source.
 */
export function staticSiteNavigation(config: StaticSiteNavigationConfig): NavigationAdapter {
  const screens = config.screens ?? [];
  const selectorFor = config.selectorFor ?? DEFAULT_SELECTOR;
  const getLocation = config.getLocation ?? defaultGetLocation;
  const performPageLoad = config.performPageLoad ?? defaultPerformPageLoad;
  const scrollToElement = config.scrollToElement ?? defaultScroll;
  const onCrossPageQueued = config.onCrossPageQueued;

  const byKey = new Map(screens.map((s) => [s.key, s] as const));

  // spec-222 dec-8 (t-4): a destructive cross-page turn is QUEUED here and flushed
  // on onPlaybackDrained — never executed synchronously inside graph.invoke.
  let pendingHref: string | null = null;

  function resolveScreenKey(location?: GuideLocation): string | null {
    const path = normalisePath((location ?? getLocation()).pathname);
    // Prefer a screen whose page matches AND has no in-page section (the page's
    // primary screen); fall back to any screen on that page.
    const onPage = screens.filter((s) => normalisePath(s.path) === path);
    if (onPage.length === 0) return null;
    return (onPage.find((s) => !s.sectionId) ?? onPage[0]).key;
  }

  function findElement(id: string): HTMLElement | null {
    if (typeof document === 'undefined') return null;
    return document.querySelector<HTMLElement>(selectorFor(id));
  }

  function navigate(target: string): NavigateOutcome {
    const screen = byKey.get(target);
    if (!screen) return { ok: false, reason: 'not a navigable screen' };

    const currentPath = normalisePath(getLocation().pathname);
    const targetPath = normalisePath(screen.path);
    const samePage = targetPath === currentPath;

    if (samePage) {
      // IN-PAGE: scroll/anchor to the section immediately — meant to land while
      // Specky is still speaking ("let me show you this ⟶").
      if (screen.sectionId) {
        const el = findElement(screen.sectionId);
        if (el) scrollToElement(el);
        return { ok: true, path: `#${screen.sectionId}` };
      }
      // Same page, no section — nothing destructive to do.
      return { ok: true, path: targetPath };
    }

    // CROSS-PAGE: a full document load is DESTRUCTIVE (tears down the WS + mic +
    // conversation). DEFER it — queue the href and flush on onPlaybackDrained so
    // Specky finishes the sentence ("Opening the docs for you…") before the page
    // turns. The tool_result still reports 'executed' (the engine's contract) so
    // narration and the deferred turn stay in sync; we control only WHEN it runs.
    pendingHref = screen.path;
    onCrossPageQueued?.(screen.path);
    return { ok: true, path: screen.path };
  }

  return {
    resolveScreenKey,
    currentScreenKey: () => resolveScreenKey(),
    navigate,
    findElement,
    elementsForScreen: (screenKey) => (screenKey ? byKey.get(screenKey)?.elements ?? [] : []),
    // The spoken turn has fully played — NOW perform any queued destructive turn.
    onPlaybackDrained: () => {
      if (pendingHref === null) return;
      const href = pendingHref;
      pendingHref = null;
      performPageLoad(href);
    },
  };
}
