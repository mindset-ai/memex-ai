// spec-222 dec-2 — the Memex app's NavigationAdapter: the react-router + `@memex/shared`
// backed implementation of the guide-sdk's navigation seam. The engine
// (`@memex/guide-sdk`) imports NEITHER react-router NOR `@memex/shared` (ac-9); ALL
// of that coupling lives HERE, in the app, behind the injected adapter. This keeps
// the app's behaviour exactly as it was before the cut — immediate soft-nav,
// registry-validated key→path resolution, live light-DOM element lookup.

import {
  resolveScreenKey,
  screenKeyToPath,
  guideElementsForScreen,
  type GuideScreenKey,
} from '@memex/shared';
import type {
  NavigationAdapter,
  NavigateOutcome,
  GuideElement,
  GuideLocation,
} from '@memex/guide-sdk';

export interface ReactRouterAdapterDeps {
  /** The app router's navigate (react-router useNavigate()). */
  navigate: (path: string) => void;
  /** Tenant scope from the CURRENT route — never resolved from product data. */
  namespace: string;
  memex: string;
}

/**
 * Build the react-router-backed NavigationAdapter the app injects into the
 * guide engine. Mirrors the behaviour the engine used to perform inline before
 * spec-222: screen-key resolution via the registry, validate-then-navigate, and
 * `[data-guide-id]` element lookup against the host light DOM.
 */
export function createReactRouterNavigationAdapter(
  deps: ReactRouterAdapterDeps,
): NavigationAdapter {
  const { navigate, namespace, memex } = deps;
  return {
    resolveScreenKey(location?: GuideLocation): string | null {
      const pathname =
        location?.pathname ??
        (typeof window !== 'undefined' ? window.location.pathname : '');
      return resolveScreenKey(pathname);
    },
    currentScreenKey(): string | null {
      return resolveScreenKey(
        typeof window !== 'undefined' ? window.location.pathname : '',
      );
    },
    navigate(screen: string): NavigateOutcome {
      // The screen key is validated against the registry BEFORE the router is
      // touched (ac-26): an unregistered or detail-only (entity-requiring)
      // destination is rejected without navigating.
      const path = screenKeyToPath(screen, { namespace, memex });
      if (!path) return { ok: false, reason: 'not a navigable screen' };
      navigate(path); // runs in the user's authed session via the app router
      return { ok: true, path };
    },
    findElement(id: string): HTMLElement | null {
      return document.querySelector<HTMLElement>(`[data-guide-id="${id}"]`);
    },
    elementsForScreen(screenKey: string | null): GuideElement[] {
      return screenKey ? guideElementsForScreen(screenKey as GuideScreenKey) : [];
    },
  };
}
