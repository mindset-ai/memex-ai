// spec-222 dec-2 — the navigation seam. The engine performs ALL screen-key
// resolution, navigation, and element-finding SOLELY through this injected
// adapter, so `packages/guide-sdk` imports NEITHER react-router NOR `@memex/shared`
// (ac-9). Both couplings that used to live in the engine —
//   - `resolveScreenKey(pathname)` / `currentScreenKey()`  (was @memex/shared)
//   - `screenKeyToPath(screen, ctx)` validation before navigate (was @memex/shared)
//   - `findGuideElement(id)` over `[data-guide-id]`         (was guideElements.ts)
// are satisfied through the methods below. The Memex app supplies a
// react-router-backed adapter that preserves its current behaviour exactly; the
// SDK ships a built-in `staticSiteNavigation()` (dec-2) for plain multi-page sites.
//
// findElement resolves against the HOST page's LIGHT DOM (the site's own markup),
// while Specky/pill mount in the SDK's own (shadow) DOM — the adapter deliberately
// straddles the boundary.

/**
 * A guide-navigable element on a screen: a stable id plus a human description the
 * model reads. This is config-data (dec-2), not a host callback — the engine owns
 * the type so the package has zero dependency on `@memex/shared`'s registry. It
 * mirrors the structural shape of the app's `GuideElement`.
 */
export interface GuideElement {
  id: string;
  description: string;
}

/** A minimal location shape — the engine never imports react-router's `Location`. */
export interface GuideLocation {
  pathname: string;
}

/**
 * One navigable screen, summarized for the model's prompt: the stable key the
 * navigate tool accepts plus a human title/description. Hosts that supply
 * `allScreens()` give the model a complete site map every turn, so "what pages
 * exist / where can you take me" is answered from the prompt — not left to
 * retrieval luck.
 */
export interface GuideScreenSummary {
  key: string;
  title: string;
  description: string;
}

/** The outcome of a navigate request, preserving the engine's existing
 *  validate-then-navigate contract (guideTools.executeNavigate): an unregistered
 *  / non-navigable destination is rejected WITHOUT navigating. */
export interface NavigateOutcome {
  ok: boolean;
  /** The resolved destination (path or href) when ok. */
  path?: string;
  /** Why navigation was refused (e.g. 'not a navigable screen'). */
  reason?: string;
}

/**
 * The injection contract the host supplies to `init()` (dec-2).
 *
 * The Memex app implements this over react-router + the `@memex/shared` registry
 * (immediate soft-nav). The website implements it over `location.pathname` +
 * in-page anchors + cross-page `href` (with destructive page-turns DEFERRED to
 * turn-complete — dec-8 — owned inside the adapter, not the engine).
 */
export interface NavigationAdapter {
  /** Derive the screen key from a location (defaults to the live location). */
  resolveScreenKey(location?: GuideLocation): string | null;

  /** The current screen key (convenience over `resolveScreenKey()`). */
  currentScreenKey(): string | null;

  /**
   * Navigate to a target screen key. The adapter OWNS key→path/href resolution
   * and the execution TIMING: the app navigates immediately (soft-nav); the
   * static site may defer a destructive cross-page turn until playback drains
   * (dec-8). Returns the validate-then-navigate outcome so the engine's tool
   * result stays accurate without the engine knowing about routing.
   */
  navigate(target: string): NavigateOutcome;

  /**
   * Resolve a guide-element id to its live node in the HOST light DOM (via
   * `[data-guide-id="<id>"]` or the host's chosen selector), or null if it isn't
   * currently rendered.
   */
  findElement(id: string): HTMLElement | null;

  /**
   * The element registry for a given screen key (config-data). Optional: hosts
   * that drive the registry through engine state may omit it.
   */
  elementsForScreen?(screenKey: string | null): GuideElement[];

  /**
   * The COMPLETE list of navigable screens (config-data), summarized for the
   * model. Optional; when present the engine sends it with every turn so the
   * prompt carries a definitive site map (key + title + description per page)
   * instead of relying on retrieval to know what pages exist.
   */
  allScreens?(): GuideScreenSummary[];

  /**
   * spec-222 dec-8 (t-4) — the engine calls this when the spoken turn has fully
   * PLAYED (the orchestrator's playback-drained signal). It is the seam where a
   * host that DEFERS destructive navigation flushes it: the website's
   * `staticSiteNavigation()` queues a cross-page page-turn during `navigate()`
   * and performs the actual document load HERE, so Specky finishes the sentence
   * before the page reloads. The Memex app's react-router adapter OMITS this hook
   * — it navigated immediately (soft-nav) inside `navigate()`. The engine stays
   * navigation-agnostic: it just signals turn-complete; the adapter owns timing.
   */
  onPlaybackDrained?(): void;
}
