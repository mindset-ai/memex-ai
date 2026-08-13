import { useState, useRef, useCallback, useId } from "react";
import { Link } from "react-router-dom";
import { statusClasses } from "../../utils/statusStyles";
import { parseTenantFromPathname } from "../../utils/tenantUrl";
import { useSpecRefStatus } from "./SpecRefStatusProvider";
import { SpecRefCard } from "./SpecRefCard";

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
  if (typeof window === "undefined") return null;
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
  if (!entry || entry.state !== "resolved") {
    return <>{handle}</>;
  }

  const doc = entry.doc;
  const href = specHref(handle);

  // A reference sits INSIDE a sentence, so its treatment has to survive being
  // repeated five times in one paragraph. A bordered chip does not: it boxes the
  // prose, blows out the line rhythm, and turns a readable sentence into a row of
  // buttons. So the phase becomes a coloured dot rather than a badge, the fraction
  // loses the word "tasks" (the card spells it out), and the whole thing carries no
  // border or fill until you point at it.
  // The face is the handle plus a MINI phase chip, and nothing else. Task progress
  // was on it and came off: repeated five times in one paragraph a fraction is
  // noise, and it is the card's job to spell the split out. The chip is the Badge
  // treatment shrunk to sit inside a line of prose without boxing it — same colour
  // per phase as everywhere else in the product, because it comes from the same map.
  const body = (
    <>
      <span className="font-medium">{handle}</span>
      <span
        className={`rounded-sm border px-1 py-px text-[0.7em] font-medium leading-none ${statusClasses(
          doc.status,
        )}`}
      >
        {doc.status.replace(/_/g, " ")}
      </span>
    </>
  );

  const shared = {
    "data-testid": "spec-ref-pill",
    "data-spec-handle": handle,
    "aria-describedby": open ? cardId : undefined,
    className:
      // `-mx-0.5 px-0.5` nets to zero inline width, so the hover background gets
      // breathing room WITHOUT pushing the following comma or full stop away from
      // the reference. Padding alone left punctuation visibly detached.
      "inline-flex items-baseline gap-1 whitespace-nowrap rounded-sm -mx-0.5 px-0.5 align-baseline " +
      "!no-underline !text-primary hover:bg-subtle/70 hover:!text-primary",
    onMouseEnter: onEnter,
    onMouseLeave: onLeave,
    // Focus and tap open it too — hover-only content is unreachable by keyboard
    // and does not exist on touch.
    onFocus: () => setOpen(true),
    onBlur: () => setOpen(false),
    onClick: () => setOpen(true),
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
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
