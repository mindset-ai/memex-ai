// ActivityRow — one row of the Pulse feed (b-60, dec-10 information hierarchy).
//
// PRESENTATIONAL. All data arrives via props; this component owns no fetching
// and no live-state. The Pulse page wires the stream/history hooks and decides
// which rows are "live", which are grouped, and which Spec is the current
// context — this file just renders what it's told.
//
// dec-10 information hierarchy — TWO lines, scannable:
//
//   Line 1 (the WHO + WHEN):   ● 12s ago   <client> (<user>)
//   Line 2 (the WHAT):         Resolved dec-4 in b-12
//
// Line 1 leads with the live dot + relative time, then the actor. Per §2 the
// agent's CLIENT LABEL leads with the human owner in de-emphasised parens, so a
// reader scanning the column sees "which agent" first and "on whose behalf"
// second. Humans render bare; system activity renders a plain "System".
//
// Line 2 is the action-led narrative (the server already writes it action-first,
// e.g. "Resolved dec-4 in b-12"). We bold + deep-link any Spec / Standard
// handle inside it so the eye lands on the resource. Decision / task titles are
// already inlined by the server; we surface the full narrative on hover.
//
// Burst/group mode: when `groupCount > 1` the row collapses to a one-line
// summary with an expand affordance. The feed manages the expanded set and
// hands us `expanded` + `onToggleExpand`; we just render the two states.

import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import { LiveDot } from './LiveDot';
import { TimeAgo } from './TimeAgo';
import { tenantPath } from '../../utils/tenantUrl';
import { clientLabel } from './clientLabel';
import type { ActivityRow as ActivityRowData } from './types';

export interface ActivityRowProps {
  /** The activity to render. */
  row: ActivityRowData;
  /** True when the row is < ~30s old — drives the breathing live dot. */
  isLive?: boolean;
  /**
   * The Spec the surrounding view is already scoped to (e.g. a Spec page's
   * Pulse rail). When set and the narrative ends with a redundant
   * "… in <thisHandle>" suffix, we strip it — the context already says where.
   */
  contextBriefHandle?: string;
  /**
   * When > 1, this row stands in for a burst of N consecutive sibling actions
   * and renders the collapsed summary instead of a single narrative.
   */
  groupCount?: number;
  /** Whether a grouped row is currently expanded (feed-managed). */
  expanded?: boolean;
  /** Toggle the grouped row's expansion. */
  onToggleExpand?: () => void;
  /**
   * Resolve a resource handle (e.g. `b-2`) to its title, so the feed can show
   * "viewing b-2 Pulse …" rather than the bare handle. Returns undefined when
   * the title isn't known (e.g. an archived Spec the page hasn't loaded), in
   * which case we just render the handle. The page supplies this from the Spec
   * list it already fetches.
   */
  specTitle?: (handle: string) => string | undefined;
  /**
   * spec-122 ac-2 — when this moving line is a REGRESSION (a previously-verified
   * AC going red), render the `⚠ REGRESSED` flag. The flag's WEIGHT is
   * presence-aware: see {@link regressionMuted}.
   */
  regressed?: boolean;
  /**
   * spec-122 ac-2 — mute the regression flag while the spec is being actively
   * worked (a worker is present in "Working now"): a red AC on a churning spec
   * is expected development churn, not an alarm. Only an UNWORKED regression
   * earns the alarming, full-weight flag. Ignored unless `regressed` is true.
   */
  regressionMuted?: boolean;
}

// std-1 handle grammar. We linkify Spec (`spec-N` / legacy `b-N`) and Standard
// (`std-N`) handles since those have a canonical page; the child handles
// (`dec-N` / `t-N` / `c-N` / `s-N`) and the generic `doc-N` are bolded as
// references but not turned into their own links here — they read inline
// within the Spec's narrative and the Spec link is the meaningful destination.
// The pattern uses \b boundaries so handles abutting prose punctuation still
// match.
const HANDLE_PATTERN = /\b((?:spec|b|std|doc|dec|t|c|s)-\d+)\b/g;

// Handles that own a top-level page we can deep-link to.
function handleHref(handle: string): string | null {
  if (/^(?:spec|b)-\d+$/.test(handle)) return tenantPath(`/specs/${handle}`);
  if (/^std-\d+$/.test(handle)) return tenantPath(`/standards/${handle}`);
  if (/^doc-\d+$/.test(handle)) return tenantPath(`/docs/${handle}`);
  return null;
}

/**
 * Split a narrative string into plain text + bold (optionally linked) handle
 * nodes, in source order. Spec/Standard/Doc handles become deep links in the
 * live accent colour; child handles render bold but unlinked. Exported for
 * unit-testing the parse independently of the React render.
 */
export function linkifyNarrative(
  narrative: string,
  specTitle?: (handle: string) => string | undefined,
): ReactNode[] {
  const out: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  HANDLE_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = HANDLE_PATTERN.exec(narrative)) !== null) {
    const handle = match[1];
    const start = match.index;
    const end = start + match[0].length;

    if (start > cursor) {
      out.push(narrative.slice(cursor, start));
    }

    const href = handleHref(handle);
    if (href) {
      out.push(
        <Link
          key={`h-${key++}`}
          to={href}
          className="font-semibold font-mono text-accent hover:text-accent-hover hover:underline"
          // Stop the row-level click (group toggle) from swallowing the nav.
          onClick={(e) => e.stopPropagation()}
        >
          {handle}
        </Link>,
      );
    } else {
      out.push(
        <strong key={`h-${key++}`} className="font-semibold font-mono text-primary">
          {handle}
        </strong>,
      );
    }

    // Surface the resource's name right after the handle, muted + truncated, so
    // a row reads "viewing b-2 Pulse — live activity…" instead of just "b-2".
    const title = specTitle?.(handle);
    if (title) {
      out.push(
        <span key={`t-${key++}`} className="text-muted">{` ${truncateTitle(title)}`}</span>,
      );
    }

    cursor = end;
  }

  if (cursor < narrative.length) {
    out.push(narrative.slice(cursor));
  }
  // No handles → return the raw string so React renders a single text node.
  return out.length === 0 ? [narrative] : out;
}

/**
 * Context-aware suffix trim: when the surrounding view is already scoped to
 * `contextBriefHandle` and the narrative ends with "… in <thatHandle>", drop the
 * redundant suffix. Matches an optional trailing period. Exported for testing.
 */
export function stripRedundantContext(
  narrative: string,
  contextBriefHandle?: string,
): string {
  if (!contextBriefHandle) return narrative;
  // " in b-12" or " in b-12." at the very end of the string.
  const suffix = new RegExp(`\\s+in ${escapeRegExp(contextBriefHandle)}\\.?$`);
  return narrative.replace(suffix, '');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Cap appended resource titles only to stop pathologically long names blowing
// out a row; the event log is full-width so we give them plenty of room. The
// full title is on hover and one click away via the handle link.
function truncateTitle(s: string, max = 90): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// The narrative's leading verb is replaced by an action icon keyed off the
// structural `row.action` (the 7-value bus enum). Heroicons-style outline
// paths; the exact verb is surfaced on hover (see ActionIcon). Unmapped actions
// fall back to a neutral dot.
const ACTION_ICON_PATHS: Record<string, string> = {
  // eye
  viewed:
    'M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
  // magnifying glass
  searched:
    'M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z',
  // plus-circle
  created: 'M12 9v6m3-3H9m12 0a9 9 0 11-18 0 9 9 0 0118 0z',
  // pencil
  updated:
    'M16.862 4.487l1.687-1.688a1.875 1.875 0 112.652 2.652L6.832 19.82a4.5 4.5 0 01-1.897 1.13l-2.685.8.8-2.685a4.5 4.5 0 011.13-1.897L16.862 4.487z',
  // trash
  deleted:
    'M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0',
  // clipboard-document-check
  assessed:
    'M11.35 3.836c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m8.9-4.414c.376.023.75.05 1.124.08 1.131.094 1.976 1.057 1.976 2.192V16.5A2.25 2.25 0 0118 18.75h-2.25m-7.5-10.5H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z',
  // command-line / terminal window
  called:
    'M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0021 18V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v12a2.25 2.25 0 002.25 2.25z',
};

// The action icon that replaces the leading verb. `label` (the actual verb, or
// the action enum as a fallback) is the hover tooltip + accessible name.
function ActionIcon({ action, label }: { action: string; label: string }) {
  const d = ACTION_ICON_PATHS[action];
  return (
    <span
      title={label}
      aria-label={label}
      role="img"
      className="inline-flex flex-none align-text-bottom text-muted"
    >
      {d ? (
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75}>
          <path strokeLinecap="round" strokeLinejoin="round" d={d} />
        </svg>
      ) : (
        <span className="my-auto inline-block h-1.5 w-1.5 rounded-full bg-current" />
      )}
    </span>
  );
}

// Split a narrative into its leading verb (first word) and the remainder, so the
// verb can be swapped for an icon. Returns verb=null when there's no leading word.
function splitLeadingVerb(s: string): { verb: string | null; rest: string } {
  const m = s.match(/^([A-Za-z][A-Za-z-]*)\s+([\s\S]*)$/);
  return m ? { verb: m[1], rest: m[2] } : { verb: null, rest: s };
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Render the actor as a PERSON and a SURFACE (spec-122 ac-4). The server already
 * resolved most names into `row.actorName`; the UI renders what it's given and
 * falls back to the client label — NEVER to "You" (which would silently collapse
 * a teammate or a CI actor into the viewer).
 *
 *   human  → their name ("Barrie")                — bare, no parens
 *   agent  → "<name>'s <client>" form. The server's actorName for an agent is
 *            already the "Claude Code (Barrie)" label; we render it verbatim. If
 *            no actorName arrived, we build "<client> (<owner>)" from the channel
 *            client label + any owner we can name (clientId), still never "You".
 *   CI     → a free-form actor string with no actorUserId ("CI · abc123") renders
 *            VERBATIM — it matched no user, so it must not be reshaped or
 *            attributed to anyone.
 *   system → "System"                             — no parens, no client
 */
function ActorLabel({ row }: { row: ActivityRowData }) {
  if (row.actorKind === 'system') {
    return <span className="text-secondary">System</span>;
  }

  const isAgent =
    row.actorKind === 'mcp_agent' || row.actorKind === 'in_app_agent';

  // The surface label (the CLIENT the action arrived through), keyed by channel.
  const surface = row.clientId ? clientLabel(row.channel, row.clientId) : null;

  if (isAgent) {
    // The server resolves an agent's actorName to the "<name>'s <client>" /
    // "Claude Code (Barrie)" form — render it verbatim when present.
    if (row.actorName) {
      return <span className="text-secondary">{row.actorName}</span>;
    }
    // No resolved name: synthesise "<client> (<owner>)". Owner falls back to the
    // surface label rather than "You" — we never claim the viewer.
    const clientText = surface ?? 'Agent';
    return <span className="text-secondary">{clientText}</span>;
  }

  // Human (or a free-form CI actor that arrived as a raw human row). The
  // resolved display name is authoritative — a CI string with no actorUserId
  // arrives AS its actorName and renders verbatim ("CI · abc123"). When no name
  // resolved at all, fall back to the surface label, never to "You".
  const human = row.actorName ?? surface ?? 'Someone';
  return <span className="text-secondary">{human}</span>;
}

/**
 * spec-122 ac-2 — the `⚠ REGRESSED` flag on a moving line. Its weight is a
 * function of PRESENCE, not just the event:
 *   - muted (greyed) while the spec has an active worker — expected churn,
 *     "active development not regression";
 *   - EARNED (alarming, full-weight danger colour) once the regression has gone
 *     quiet (no active worker on that spec).
 * The two render differently: a `data-muted` flag + an aria suffix + colour, so
 * a manager (and a test) can tell an alarm from churn at a glance.
 */
function RegressedFlag({ muted }: { muted: boolean }) {
  return (
    <span
      data-testid="regressed-flag"
      data-muted={muted ? 'true' : 'false'}
      aria-label={
        muted
          ? 'Regressed while actively worked — expected churn'
          : 'Regressed and quiet — needs attention'
      }
      title={
        muted
          ? 'A verified AC went red while this spec is being actively worked — expected churn.'
          : 'A verified AC went red on a quiet spec — this is an alarm.'
      }
      className={`ml-2 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase tracking-wide ${
        muted
          ? 'text-muted/70 bg-card-hover/40'
          : 'text-status-danger-text bg-status-danger-bg'
      }`}
    >
      <span aria-hidden="true">⚠</span> Regressed
    </span>
  );
}

export function ActivityRow({
  row,
  isLive = false,
  contextBriefHandle,
  groupCount,
  expanded = false,
  onToggleExpand,
  specTitle,
  regressed = false,
  regressionMuted = false,
}: ActivityRowProps) {
  const isGroup = !!groupCount && groupCount > 1;

  // Collapsed burst summary: one line standing in for N sibling actions. The
  // Spec is the natural anchor; fall back to the bare count when we have no
  // handle to name. Clicking anywhere on the summary toggles expansion.
  if (isGroup && !expanded) {
    const specHandle = specHandleFromNarrative(row.narrative);
    return (
      <button
        type="button"
        onClick={onToggleExpand}
        data-testid="activity-row-group"
        aria-expanded={false}
        className="group flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-muted hover:bg-card-hover rounded transition-colors"
      >
        <LiveDot live={isLive} size="sm" />
        <span className="text-muted/70">&hellip;</span>
        <span className="opacity-40">&middot;</span>
        <span>
          {groupCount} actions
          {specHandle ? (
            <>
              {' on '}
              <Link
                to={handleHref(specHandle) ?? '#'}
                className="font-semibold font-mono text-accent hover:text-accent-hover hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                {specHandle}
              </Link>
            </>
          ) : null}
        </span>
        <span className="ml-auto text-muted opacity-60 group-hover:opacity-100">
          Show
        </span>
      </button>
    );
  }

  const text = stripRedundantContext(row.narrative, contextBriefHandle);
  // Swap the leading verb for an action icon; keep the verb as the hover label.
  const { verb, rest } = splitLeadingVerb(text);
  const actionLabel = capitalize(verb ?? row.action);

  return (
    <div
      data-testid="activity-row"
      data-entity={row.entity}
      data-action={row.action}
      className="px-3 py-1.5"
    >
      {/* Line 1 — WHO + WHEN. */}
      <div className="flex items-center gap-2 text-xs text-muted">
        <LiveDot live={isLive} size="sm" />
        <TimeAgo value={row.createdAt} className="tabular-nums" />
        <span className="opacity-40">&middot;</span>
        <ActorLabel row={row} />
        {regressed ? <RegressedFlag muted={regressionMuted} /> : null}
        {isGroup && expanded ? (
          <button
            type="button"
            onClick={onToggleExpand}
            aria-expanded
            className="ml-auto text-muted opacity-60 hover:opacity-100"
          >
            Collapse
          </button>
        ) : null}
      </div>

      {/* Line 2 — WHAT. The leading verb is rendered as an action icon (the verb
          itself shows on hover); the full narrative is on the line's title. */}
      <div className="mt-0.5 text-sm text-primary leading-snug" title={row.narrative}>
        <ActionIcon action={row.action} label={actionLabel} />{' '}
        {linkifyNarrative(verb ? rest : text, specTitle)}
      </div>
    </div>
  );
}

// Pull the first Spec handle out of a narrative for the group summary anchor.
// Both new `spec-N` and legacy `b-N` are accepted (server narratives may still
// carry the legacy form until the migration ripples through).
function specHandleFromNarrative(narrative: string): string | null {
  const m = narrative.match(/\b(?:spec|b)-\d+\b/);
  return m ? m[0] : null;
}
