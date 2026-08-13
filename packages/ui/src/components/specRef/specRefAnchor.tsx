import type { Components } from 'react-markdown';
import { SpecRefPill } from './SpecRefPill';

/**
 * spec-529 t-6 — the seam between the rehype plugin and the live pill.
 *
 * `rehypeSpecRefLinkifier` stamps `data-spec-ref` / `data-spec-handle` on an
 * anchor; this reads them back and upgrades it. Every markdown surface uses the
 * same helper so the upgrade cannot drift between them, and a surface that
 * already maps `a` for its own reasons composes by calling `specRefHandle` first
 * and falling through when it returns null.
 *
 * react-markdown hands hast properties in both dashed and camel form depending
 * on version and plugin path, so both are read.
 */
export function specRefHandle(node: unknown): string | null {
  const props =
    ((node as { properties?: Record<string, unknown> } | undefined)?.properties ??
      {}) as Record<string, unknown>;
  if (!(props['data-spec-ref'] ?? props['dataSpecRef'])) return null;
  const handle = String(props['data-spec-handle'] ?? props['dataSpecHandle'] ?? '');
  return handle.length > 0 ? handle : null;
}

/**
 * The `a` mapping for a surface with no anchor handling of its own. A non-pill
 * anchor renders exactly as react-markdown would have rendered it.
 */
export const specRefComponents: Components = {
  a: ({ children, href, node, ...rest }) => {
    const handle = specRefHandle(node);
    if (handle) return <SpecRefPill handle={handle} />;
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
};
