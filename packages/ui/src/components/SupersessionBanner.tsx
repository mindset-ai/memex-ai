// spec-521 t-5 (ac-14) — supersession on the Spec page. DISPLAY-ONLY.
//
// dec-4, in the user's words: "No supersede button needed for the website. This will
// purely be an MCP tool." So this file renders state and offers no control — there is
// no set, no clear, no modal, and no route from the web that writes the supersession
// columns.
//
// WHY NO PROMPT BUTTON EITHER (std-34, and this is the subtle part). std-34 requires a
// handoff affordance on any surface "whose next step is MCP-only". A page that DISPLAYS
// supersession and never invites the user to set it instructs no MCP-only step, so no
// Prompt Button is owed and none is added — deliberately, because adding one would
// imply the user has a job to do here and they do not. The obligation attaches the
// moment any copy suggests the user could mark a Spec superseded; at that point it
// would need a real, fully-wired Prompt Button (std-23) with the tool name only inside
// the prompt text. So: no MCP tool is named in any string below.
//
// dec-4 also records the failure this shape avoids — spec-93's candidate-decision
// radios silently dropped the user's pick because the web pretended to own an MCP-side
// step. There is no control here, so there is nothing to half-wire. Keep it that way.
//
// ACCESSIBILITY. `role="status"` so a screen reader announces the state, and the
// meaning never rides on colour alone — the word SUPERSEDED and the successor's handle
// carry it in text, which is also what makes it survive high-contrast mode. std-27's
// chart palette rules do NOT apply: this is a banner, not a data visualisation.

import { Link } from 'react-router-dom';
import { Badge } from './ui';
import { tenantPath } from '../utils/tenantUrl';

interface SupersededByBannerProps {
  /** The successor's handle, e.g. `spec-510`. */
  successorHandle: string;
  /** When the supersession was recorded (ISO). */
  supersededAt?: string | null;
  /** Why — the capped note recorded with the pointer. */
  note?: string | null;
}

function formatWhen(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * The banner a SUPERSEDED Spec opens with, above its narrative.
 *
 * Its phase badge stays untouched elsewhere on the page — the Spec is still whatever
 * phase it was in, and this banner is what tells you not to act on it. That split is
 * deliberate: overloading the phase badge would lose real information.
 */
export function SupersededByBanner({
  successorHandle,
  supersededAt,
  note,
}: SupersededByBannerProps) {
  const when = formatWhen(supersededAt);
  return (
    <div
      role="status"
      data-testid="superseded-by-banner"
      className="mb-4 rounded-lg border border-edge bg-panel px-4 py-3 flex items-start gap-3"
    >
      {/* Reuses the existing `archived` status treatment rather than inventing a
          palette for inert-Spec state (design §3.3). */}
      <Badge status="archived" label="superseded" className="mt-0.5 shrink-0" />
      <p className="text-sm text-primary">
        <span className="font-medium text-heading">Superseded by </span>
        <Link
          to={tenantPath(`/specs/${successorHandle}`)}
          className="font-medium text-accent hover:underline"
        >
          {successorHandle}
        </Link>
        {when ? <span className="text-muted"> on {when}</span> : null}
        {note ? <span>: {note}</span> : null}
        {' — '}
        <span className="text-muted">
          work from {successorHandle} instead; this Spec is kept as history.
        </span>
      </p>
    </div>
  );
}

interface ReplacesBannerProps {
  /** Handles of every Spec this one replaced. */
  predecessorHandles: string[];
}

/**
 * The mirror the SUCCESSOR carries. ONE line however many predecessors — a Spec that
 * absorbed five others must not open with five lines of bookkeeping.
 */
export function ReplacesBanner({ predecessorHandles }: ReplacesBannerProps) {
  if (predecessorHandles.length === 0) return null;
  return (
    <div
      role="status"
      data-testid="replaces-banner"
      className="mb-4 rounded-lg border border-edge bg-panel px-4 py-2"
    >
      <p className="text-sm text-muted">
        Replaces{' '}
        {predecessorHandles.map((handle, i) => (
          <span key={handle}>
            {i > 0 ? ', ' : ''}
            <Link
              to={tenantPath(`/specs/${handle}`)}
              className="text-accent hover:underline"
            >
              {handle}
            </Link>
          </span>
        ))}
        .
      </p>
    </div>
  );
}
