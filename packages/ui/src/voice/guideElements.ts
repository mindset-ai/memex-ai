// spec-190 t-4 / dec-3: the runtime binding between the screen-element registry
// (@memex/shared guide-registry) and the live DOM. Highlightable components carry
// `data-guide-id="<id>"`; the highlight tool (t-5) calls findGuideElement(id) to
// resolve a registry id to the live node at runtime — no refs threaded through
// component trees, resilient to layout changes. currentScreenKey derives the
// graph's screenKey (dec-1) from the router location via the registry mapping.

import { resolveScreenKey, type GuideScreenKey } from '@memex/shared';

/**
 * Resolve a registry element id to its live DOM node via its data-guide-id
 * attribute, or null if it isn't currently rendered. Ids are controlled
 * kebab-case (registry-defined), so the attribute selector is safe.
 */
export function findGuideElement(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-guide-id="${id}"]`);
}

/** The current screen key derived from the router pathname (or null off-screen). */
export function currentScreenKey(
  pathname: string = typeof window !== 'undefined' ? window.location.pathname : '',
): GuideScreenKey | null {
  return resolveScreenKey(pathname);
}
