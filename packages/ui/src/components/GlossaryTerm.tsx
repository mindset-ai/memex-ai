import { useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// The journey glossary: friendly, plain-English definitions for the nouns the
// onboarding journey introduces, anchored to a familiar construct where one fits.
// Built as reusable plumbing so the same terms can light up anywhere in the
// journey (and, sparingly, elsewhere in the product). Definitions are always a
// BONUS: the surrounding copy must read fine without ever opening the pop-up, so
// no load-bearing information lives here.
export const GLOSSARY = {
  spec: `Like a blueprint or spec doc, except it doesn't rot: your agent reads it, builds to it, and the tests keep it honest.`,
  standard: `Your team's house rules: set once, followed everywhere, including by your agent.`,
  decision: `A call you've made, written down with the why, so it stops getting re-argued. Think "we chose X because Y."`,
  ac: `The finish line in plain words: exactly what "done" means, and a passing test crosses it for you.`,
} as const;

export type GlossaryKey = keyof typeof GLOSSARY;

/**
 * GlossaryTerm — wraps a jargon noun with a dotted underline and a friendly
 * pop-up definition. Reveals on hover, on keyboard focus, and on tap (toggle),
 * so it works on desktop and touch. Accessible: focusable, described-by the
 * tooltip, and Escape-dismissable.
 *
 * The pop-up is rendered through a PORTAL to document.body and positioned
 * `fixed` off the trigger, so it can extend beyond the journey card (whose
 * `overflow-hidden` would otherwise clip it) and is never illegible behind it.
 * The definition is decoration over meaning — the sentence stands on its own.
 */
export function GlossaryTerm({ term, children }: { term: GlossaryKey; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const id = useId();

  const show = () => {
    const el = triggerRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      setPos({ top: r.bottom + 8, left: r.left + r.width / 2 });
    }
    setOpen(true);
  };
  const hide = () => setOpen(false);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid={`glossary-term-${term}`}
        aria-describedby={open ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onClick={() => (open ? hide() : show())}
        onKeyDown={(e) => {
          if (e.key === 'Escape') hide();
        }}
        className="cursor-help bg-transparent p-0 align-baseline font-[inherit] text-[inherit] underline decoration-dotted underline-offset-4 transition-colors hover:text-primary"
      >
        {children}
      </button>
      {open &&
        pos &&
        typeof document !== 'undefined' &&
        createPortal(
          <span
            id={id}
            role="tooltip"
            style={{ position: 'fixed', top: pos.top, left: pos.left, transform: 'translateX(-50%)' }}
            className="pointer-events-none z-[60] w-64 max-w-[calc(100vw-1rem)] rounded-lg border border-edge-subtle bg-surface p-3 text-left text-xs font-normal leading-relaxed text-secondary shadow-lg"
          >
            {GLOSSARY[term]}
          </span>,
          document.body,
        )}
    </>
  );
}
