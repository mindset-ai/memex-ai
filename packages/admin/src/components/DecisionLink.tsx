import { useState, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  fetchDecisionByHandle,
  fetchDoc,
  fetchTaskByHandle,
  NotFoundError,
} from '../api/client';

/**
 * Per t-7: cite display auto-upgrades legacy `[per doc-N:dec-M]` to canonical
 * `[per mis-N:dec-M]` when the parent document is a Spec. (The `mis-N` literal
 * pre-dates the b-105 rename and is kept as the wire/data form — only the
 * product noun moved to "Spec".) Source content stays untouched — the upgrade
 * is purely the rendered label.
 *
 * Cache is keyed on the doc handle (which is per-account in this client; the
 * tenant subdomain narrows scope already). One in-flight promise per handle
 * collapses sibling DecisionLinks for the same parent into a single fetch,
 * keeping initial paint cheap when a section cites many decisions in the same
 * Spec. Unbounded growth is fine for current standard sizes (handfuls of
 * unique parent docs per page).
 *
 * Spec docType: the b-105 rename collapsed all prior aliases into `'spec'`.
 * The set is kept here as a single-element collection so adding future
 * Spec-equivalent docTypes is a one-line change.
 */
const SPEC_DOC_TYPES = new Set(['spec']);
const parentDocTypeCache = new Map<string, Promise<string | null>>();

async function resolveParentDocType(docHandle: string): Promise<string | null> {
  let pending = parentDocTypeCache.get(docHandle);
  if (!pending) {
    pending = fetchDoc(docHandle)
      .then((d) => d.docType ?? null)
      .catch(() => null); // Network/404 → no upgrade, keep source label.
    parentDocTypeCache.set(docHandle, pending);
  }
  return pending;
}

// For tests — clears the cache between cases so each test sees a fresh fetch.
export function _resetParentDocTypeCacheForTesting(): void {
  parentDocTypeCache.clear();
}

/**
 * Compute the display label for a cite handle. Returns the canonical Spec
 * form when the parent is known to be a Spec; otherwise returns the input
 * verbatim. Pure / synchronous — call it with the resolved parent docType
 * (null when not yet resolved or not applicable).
 */
export function formatDecisionCiteLabel(
  handle: string,
  parentDocType: string | null,
): string {
  // Bare `dec-N` carries no parent — leave alone.
  const docMatch = handle.match(/^doc-(\d+):dec-(\d+)$/);
  if (docMatch && parentDocType && SPEC_DOC_TYPES.has(parentDocType)) {
    return `mis-${docMatch[1]}:dec-${docMatch[2]}`;
  }
  // `mis-N:dec-M` is already canonical; bare and non-Spec stay verbatim.
  return handle;
}

/**
 * Per dec-17 / dec-18 / dec-28 / t-20 W-A / t-7 — standard sections reference
 * decisions inline in three forms:
 *   - `[per mis-N:dec-M]` — NEW canonical (Spec cite, t-7)
 *   - `[per doc-N:dec-M]` — legacy qualified (t-20 W-A)
 *   - `[per dec-M]`       — legacy bare (may collide → 409)
 * This component renders one such reference as a clickable inline link styled
 * like the underlying handle. On click it resolves the handle to a Decision
 * (server-side, scoped to the current account) and navigates to the parent
 * spec doc, deep-linking the decisions tab + the specific decision via
 * `?decision=<handle>`.
 *
 * The displayed label auto-upgrades to the canonical Spec form: when the
 * incoming `handle` is the legacy `doc-N:dec-M` form AND the parent is a
 * Spec (resolved server-side via `fetchDocByHandle`), the rendered text
 * becomes `mis-N:dec-M`. Source content stays untouched — the upgrade is
 * display-only so legacy standards render in the new canonical form without
 * a content rewrite.
 *
 * Resolution of the handle's *target* is still lazy on click; the parent-kind
 * upgrade for the *display label* uses the lightweight document lookup. The
 * label fetch runs once per (handle, parent) pair and is cached on the doc
 * handle to keep many sibling cites cheap on the initial paint.
 *
 * Bare references that resolve to multiple matches surface a 409 from the
 * server — caught here and rendered as "ambiguous (N matches)" so the user
 * knows the legacy reference needs disambiguating in the source content.
 */
export function DecisionLink({
  handle,
  parentDocId,
}: {
  handle: string;
  /**
   * b-42 t-2: optional doc id scope for bare-handle resolution. When the link
   * is rendered inside a section / comment that belongs to a doc, pass that
   * doc's id so bare `[per dec-N]` references resolve to the local dec-N
   * instead of 409ing on memexes that have dec-1 in multiple Specs. Qualified
   * handles (`doc-N:dec-M`, `mis-N:dec-M`) ignore this — they already encode
   * the parent.
   */
  parentDocId?: string;
}) {
  const navigate = useNavigate();
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [displayLabel, setDisplayLabel] = useState<string>(handle);

  // t-7 display upgrade: when the source content carries the legacy
  // `[per doc-N:dec-M]` form but the parent is a Spec, render the canonical
  // `[per mis-N:dec-M]` label. The fetch is shared per-handle via the module
  // cache above, so many sibling cites for the same Spec only round-trip
  // once. Bare `dec-N` skips this entirely (no parent handle to resolve).
  useEffect(() => {
    setDisplayLabel(handle);
    const docMatch = handle.match(/^doc-(\d+):dec-\d+$/);
    if (!docMatch) return; // bare or already mis-qualified
    let cancelled = false;
    resolveParentDocType(`doc-${docMatch[1]}`).then((docType) => {
      if (cancelled) return;
      setDisplayLabel(formatDecisionCiteLabel(handle, docType));
    });
    return () => {
      cancelled = true;
    };
  }, [handle]);

  const handleClick = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      if (resolving) return;
      setError(null);
      setResolving(true);
      try {
        const decision = await fetchDecisionByHandle(handle, parentDocId);
        // Navigate to the parent spec doc with `?decision=<handle>` so the
        // DocDocument page can pre-select the decisions tab and (when the
        // panel grows a deep-link reader) scroll to the matching row. The
        // handle is preserved verbatim — qualified `doc-N:dec-M` round-trips
        // through encodeURIComponent so the colon survives URL parsing.
        navigate(`/docs/${decision.docId}?decision=${encodeURIComponent(handle)}`);
      } catch (err) {
        if (err instanceof NotFoundError) {
          setError(`${handle} not found`);
        } else if (
          err instanceof Error &&
          err.message.toLowerCase().includes('ambiguous')
        ) {
          // 409 from getDecisionByHandle — bare reference matches multiple
          // decisions in the account. Surface so the author can rewrite as
          // qualified `[per doc-N:dec-M]`. The fetch helper currently throws a
          // plain Error with the server message; if the response payload is
          // surfaced later this branch can read `.candidates`.
          setError('ambiguous reference');
        } else {
          setError('lookup failed');
        }
      } finally {
        setResolving(false);
      }
    },
    [handle, navigate, resolving, parentDocId],
  );

  return (
    <button
      type="button"
      onClick={handleClick}
      data-testid="decision-link"
      // The data attribute carries the *source* handle (verbatim from the
      // standard content) so test selectors and click-tracking remain stable
      // across the t-7 display upgrade. The visible label may render in the
      // canonical Spec form even when source content is the legacy doc-form.
      data-decision-handle={handle}
      data-decision-display={displayLabel}
      disabled={resolving}
      title={
        error
          ? `${displayLabel}: ${error}`
          : resolving
          ? `Resolving ${displayLabel}…`
          : `Open source decision ${displayLabel}`
      }
      className={`
        inline-flex items-center font-mono text-[0.95em]
        rounded px-1 py-px transition-colors
        ${error
          ? 'text-status-danger-text bg-status-danger-bg cursor-default'
          : 'text-accent hover:text-accent-hover hover:bg-card-hover cursor-pointer'}
        disabled:opacity-60
      `}
    >
      {displayLabel}
    </button>
  );
}

/**
 * t-19 W3.2: Sibling component for `[per t-N]` task references inside comment
 * bodies. Resolves the handle via `/api/tasks/by-handle/:handle` and navigates
 * to the parent spec doc, opening the tasks tab. Same lazy-on-click pattern
 * as `DecisionLink`.
 */
export function TaskLink({
  handle,
  parentDocId,
}: {
  handle: string;
  /** b-42 t-2: see DecisionLink. */
  parentDocId?: string;
}) {
  const navigate = useNavigate();
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleClick = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault();
      if (resolving) return;
      setError(null);
      setResolving(true);
      try {
        const task = await fetchTaskByHandle(handle, parentDocId);
        navigate(`/docs/${task.docId}?tab=tasks&task=${encodeURIComponent(handle)}`);
      } catch (err) {
        if (err instanceof NotFoundError) {
          setError(`${handle} not found`);
        } else {
          setError('lookup failed');
        }
      } finally {
        setResolving(false);
      }
    },
    [handle, navigate, resolving, parentDocId],
  );

  return (
    <button
      type="button"
      onClick={handleClick}
      data-testid="task-link"
      data-task-handle={handle}
      disabled={resolving}
      title={
        error
          ? `${handle}: ${error}`
          : resolving
          ? `Resolving ${handle}…`
          : `Open source task ${handle}`
      }
      className={`
        inline-flex items-center font-mono text-[0.95em]
        rounded px-1 py-px transition-colors
        ${error
          ? 'text-status-danger-text bg-status-danger-bg cursor-default'
          : 'text-accent hover:text-accent-hover hover:bg-card-hover cursor-pointer'}
        disabled:opacity-60
      `}
    >
      {handle}
    </button>
  );
}

/**
 * Parse a piece of section content into an array of plain-text strings and
 * `{ handle: string }` markers, in source order. The matcher is intentionally
 * conservative — it accepts:
 *   - the Spec-qualified canonical form `[per mis-N:dec-M]` (t-7; preferred)
 *   - the doc-qualified legacy form        `[per doc-N:dec-M]` (t-20 W-A)
 *   - the bare legacy form                 `[per dec-M]`
 * and leaves anything else as text.
 *
 * Exported for unit-testing the parser independently from the React render.
 */
export interface DecisionLinkParseSegment {
  kind: 'text' | 'ref';
  value: string;
}

// Matches any of the three cite forms. Captures the entire handle (with optional
// `mis-N:` or `doc-N:` prefix) so the segment passes through to
// `<DecisionLink handle=…>` verbatim — the component handles parent-kind
// resolution and display upgrade.
const PER_DEC_REGEX = /\[per ((?:(?:mis|doc)-\d+:)?dec-\d+)\]/g;

export function parseDecisionRefs(content: string): DecisionLinkParseSegment[] {
  const segments: DecisionLinkParseSegment[] = [];
  let lastIndex = 0;
  // Reset state on a fresh string — `g` regexes are stateful otherwise.
  PER_DEC_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PER_DEC_REGEX.exec(content)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: 'text', value: content.slice(lastIndex, match.index) });
    }
    segments.push({ kind: 'ref', value: match[1] });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) {
    segments.push({ kind: 'text', value: content.slice(lastIndex) });
  }
  return segments;
}

/**
 * t-19 W3.2: Generalised parser for cross-entity references inside comment
 * bodies. Recognises `[per dec-N]` and `[per t-N]` and emits ordered segments
 * tagged with the entity kind, so `CommentBubble` can render them as
 * `<DecisionLink>` / `<TaskLink>` respectively. Anything else stays as text.
 */
export interface EntityRefSegment {
  kind: 'text' | 'dec' | 'task';
  value: string;
}

// Like PER_DEC_REGEX but also captures `[per t-N]`. Decision references may be
// Spec-qualified (`mis-N:dec-M`, t-7), doc-qualified (`doc-N:dec-M`, t-20 W-A
// legacy), or bare (`dec-M`, legacy); task references stay bare since `t-N` is
// account-unique today.
const PER_REF_REGEX = /\[per ((?:(?:mis|doc)-\d+:)?dec-\d+|t-\d+)\]/g;

export function parseEntityRefs(content: string): EntityRefSegment[] {
  const segments: EntityRefSegment[] = [];
  let lastIndex = 0;
  PER_REF_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PER_REF_REGEX.exec(content)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: 'text', value: content.slice(lastIndex, match.index) });
    }
    const handle = match[1];
    // Qualified `doc-N:dec-M` and bare `dec-M` both go to the dec channel; `t-M`
    // stays as task. The kind is determined by the trailing handle component.
    const kind: EntityRefSegment['kind'] = handle.startsWith('t-') ? 'task' : 'dec';
    segments.push({ kind, value: handle });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < content.length) {
    segments.push({ kind: 'text', value: content.slice(lastIndex) });
  }
  return segments;
}
