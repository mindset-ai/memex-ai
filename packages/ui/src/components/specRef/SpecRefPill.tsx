import { useState, useRef, useCallback, useId } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '../ui';
import { parseTenantFromPathname } from '../../utils/tenantUrl';
import { useSpecRefStatus } from './SpecRefStatusProvider';
import { SpecRefCard } from './SpecRefCard';

/**
 * spec-529 t-4 — the interactive pill a bare `spec-N` becomes.
 *
 * The face carries three things and no more: the handle, the phase, and task
 * progress as a terse fraction. The TITLE is deliberately absent from the face —
 * Spec titles are full sentences in this product's house style, and inlining one
 * mid-paragraph would wreck the line. The title belongs on the card, which has
 * room for it.
 *
 * A handle that does not resolve — no such Spec, or not this reader's to see —
 * renders as ordinary text with no pill, no link and no hover affordance. That
 * is not a courtesy; a pill that looked different for "exists but forbidden"
 * would leak exactly what std-7 exists to hide, so absent and forbidden must be
 * indistinguishable here as well as on the wire.
 */

/** Where a resolved handle points. Built here rather than in the rehype plugin,
 *  which has no namespace/memex context to build it from. */
function specHref(handle: string): string | null {
  if (typeof window === 'undefined') return null;
  const tenant = parseTenantFromPathname(window.location.pathname);
  if (!tenant) return null;
  return `/${tenant.namespace}/${tenant.memex}/specs/${handle}`;
}

export function SpecRefPill({ handle }: { handle: string }) {
  const entry = useSpecRefStatus(handle);
  const [open, setOpen] = useState(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardId = useId();

  const cancelHover = useCallback(() => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }, []);

  // Hover INTENT, not mouse travel: a pointer crossing the pill on its way
  // somewhere else should not open anything. Nothing is fetched either way —
  // the status is already in the page's resolved set.
  const onEnter = useCallback(() => {
    cancelHover();
    hoverTimer.current = setTimeout(() => setOpen(true), 120);
  }, [cancelHover]);

  const onLeave = useCallback(() => {
    cancelHover();
    setOpen(false);
  }, [cancelHover]);

  // Unresolved, still resolving, or no provider above us: the handle renders as
  // it was written. This is also the every-degradation path — a failed request,
  // an anonymous reader on a public page, a surface that never opted in.
  if (!entry || entry.state !== 'resolved') {
    return <>{handle}</>;
  }

  const doc = entry.doc;
  const href = specHref(handle);
  const progress = doc.taskProgress;

  const body = (
    <>
      <span className="font-medium">{handle}</span>
      <Badge status={doc.status} className="ml-1" />
      {progress && (
        <span className="ml-1 text-[11px] text-secondary tabular-nums">
          {progress.complete}/{progress.total} tasks
        </span>
      )}
    </>
  );

  const shared = {
    'data-testid': 'spec-ref-pill',
    'data-spec-handle': handle,
    'aria-describedby': open ? cardId : undefined,
    className:
      'inline-flex items-center gap-0.5 rounded-sm border border-subtle bg-subtle/40 px-1 py-0.5 align-baseline no-underline hover:border-accent/60',
    onMouseEnter: onEnter,
    onMouseLeave: onLeave,
    // Focus and tap open it too — hover-only content is unreachable by keyboard
    // and does not exist on touch.
    onFocus: () => setOpen(true),
    onBlur: () => setOpen(false),
    onClick: () => setOpen(true),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    },
  };

  return (
    <span className="relative inline-block">
      {href ? (
        <Link to={href} {...shared}>
          {body}
        </Link>
      ) : (
        // No tenant in the path (an embedded or bare-domain render): still a pill,
        // still hoverable, just not navigable.
        <span {...shared} tabIndex={0} role="button">
          {body}
        </span>
      )}
      {open && <SpecRefCard id={cardId} doc={doc} />}
    </span>
  );
}
