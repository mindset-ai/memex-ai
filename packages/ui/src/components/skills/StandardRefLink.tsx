// spec-300 t-6 — inline `[per std-N]` references inside a SKILL.md render as
// clickable links to the cited Standard (ac-12).
//
// The mechanism mirrors Standard.tsx's `[per dec-N]` handling: react-markdown
// only invokes component overrides for ELEMENTS in the parsed tree, and the bare
// `[per std-N]` syntax produces plain text nodes we can't intercept via the
// `components` map. So we pre-encode the source into a `<standardref>` element
// (encodeStandardRefs) and map that tag to <StandardRefLink> in the components
// override. Storage stays plain markdown — this is a render-time transform.

import { Link } from 'react-router-dom';
import { tenantPath } from '../../utils/tenantUrl';

// Matches the shorthand cite `[per std-N]` (the form used across skill + standard
// bodies). `\d+` keeps the handle numeric; the surrounding brackets + "per " are
// consumed so the rendered link shows the canonical `std-N` label.
const PER_STD_REGEX = /\[per (std-\d+)\]/g;

/**
 * Pre-convert `[per std-N]` occurrences in SKILL.md source into `<standardref>`
 * elements so the react-markdown `components` map can render each as a link.
 * HTML-safe: the handle is `std-` + digits only. Exported for unit testing.
 */
export function encodeStandardRefs(content: string): string {
  return content.replace(
    PER_STD_REGEX,
    (_match, handle: string) => `<standardref handle="${handle}" />`,
  );
}

/**
 * One `[per std-N]` reference rendered as an in-app link to the Standard's page
 * (`/<ns>/<mx>/standards/std-N`). A router <Link> so the click stays inside the
 * SPA rather than triggering a full navigation.
 */
export function StandardRefLink({ handle }: { handle?: string }) {
  if (!handle) return null;
  return (
    <Link
      to={tenantPath(`/standards/${handle}`)}
      data-testid="standard-ref-link"
      data-standard-handle={handle}
      title={`Open standard ${handle}`}
      className="inline-flex items-center font-mono text-[0.95em] rounded-sm px-1 py-px text-accent hover:text-accent-hover hover:bg-card-hover transition-colors"
    >
      {handle}
    </Link>
  );
}
