// spec-222 t-5 — shared TYPES for the bundle's loader/engine split. Type-only, so
// the loader importing this adds NO runtime coupling to the engine (ac-8): the
// loader's only runtime path to the heavy engine is the dynamic `import('./engine')`.

import type { NavigationAdapter } from '../navigation/NavigationAdapter';
import type { GuideCapabilities } from '../guideTools';

/** The config a static site passes to `window.mindset.guide.init({...})` (ac-7). */
export interface GuideBundleConfig {
  /** The host surface identity (e.g. 'memex-website'). Threaded to the engine. */
  surface: string;
  /** Base URL the guide endpoints hang off (injected via setGuideBackend). */
  backend: string;
  /** The injected navigation seam (dec-2). The website passes the result of
   *  `window.mindset.guide.staticSiteNavigation({ screens: [...] })`. */
  navigation: NavigationAdapter;
  /** Host capability flags. The website omits `walkthrough` so the demo tools stay
   *  inert (ac-6, ac-18); the Memex app sets `{ walkthrough: true }`. */
  capabilities?: GuideCapabilities;
}

/** What `mountEngine` hands back to the loader (for teardown / tests). */
export interface MountedEngine {
  /** Unmount the React tree + release the session. */
  unmount: () => void;
}

/** The engine chunk's public entry, resolved lazily by the loader (ac-8). */
export interface EngineModule {
  mountEngine: (args: {
    shadow: ShadowRoot;
    config: GuideBundleConfig;
    /** spec-264 t-1 (dec-1): fired after the engine's first paint so the loader can
     *  hide its doorway without a flicker. */
    onFirstPaint?: () => void;
  }) => Promise<MountedEngine>;
}
