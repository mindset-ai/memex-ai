// spec-190 t-4 / dec-3 — the runtime binding between a screen-element registry id
// and the live DOM. Highlightable components carry `data-guide-id="<id>"`; the
// highlight tool (t-5) calls findGuideElement(id) to resolve a registry id to the
// live node at runtime — no refs threaded through component trees, resilient to
// layout changes.
//
// spec-222 (ac-9): this module no longer imports `@memex/shared`. Screen-key
// resolution (the old `currentScreenKey` / `resolveScreenKey`) now lives in the
// injected NavigationAdapter — the engine never resolves routes itself.

/**
 * Resolve a registry element id to its live DOM node via its data-guide-id
 * attribute, or null if it isn't currently rendered. Ids are controlled
 * kebab-case (registry-defined), so the attribute selector is safe.
 */
export function findGuideElement(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-guide-id="${id}"]`);
}
