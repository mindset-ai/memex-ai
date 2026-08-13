import { useState, useRef, useCallback, useId } from "react";
import { Link } from "react-router-dom";
import { statusTextClass } from "../../utils/statusStyles";
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
  // ONE capsule around the whole reference. Two free-floating elements with a gap
  // between them do not read as a unit: in a paragraph naming five Specs you cannot
  // tell which phase belongs to which handle. The enclosing background is what makes
  // the pairing unambiguous.
  //
  // The phase inside is COLOURED TEXT, not a second chip. A chip inside a chip is a
  // box inside a box, which is exactly what made the first treatment clunky.
  const body = (
    <>
      <span className="font-medium">{handle}</span>
      <span className={`text-[0.8em] ${statusTextClass(doc.status)}`}>
        {doc.status.replace(/_/g, " ")}
      </span>
    </>
  );

  const shared = {
    "data-testid": "spec-ref-pill",
    "data-spec-handle": handle,
    "aria-describedby": open ? cardId : undefined,
    className:
      // A VISIBLE edge is what makes the pairing unambiguous. A soft fill alone was
      // tried and failed: against the panel it is nearly invisible, so the handle and
      // its phase still read as two loose elements in a paragraph naming five Specs.
      // The border can be this quiet only because the phase inside is coloured text
      // rather than a nested chip — one box, not a box in a box.
      "inline-flex items-baseline gap-1 whitespace-nowrap rounded-sm border border-subtle bg-subtle/40 " +
      // No negative margin: it existed to keep punctuation tight when the pill had
      // no border, and with one it tucks the following comma under the border edge.
      "px-1.5 py-px align-baseline " +
      "!no-underline !text-primary hover:border-accent/50 hover:bg-subtle hover:!text-primary",
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
