// spec-418 t-6 — the shared chrome for the three tag-curation dialogs (create /
// rename / delete). Factored out so every dialog inherits the same a11y contract
// once (ac-34, WCAG baseline):
//   - portal to <body>, role="dialog" aria-modal, labelled by its title;
//   - FOCUS TRAP: Tab / Shift+Tab cycle within the dialog, never escaping to the
//     page behind it;
//   - closes on Escape and on backdrop click;
//   - RETURNS focus to the trigger element on unmount (the row button / New-tag
//     button that opened it), so a keyboard user lands back where they were.
//
// Deliberately carries NO descriptive sub-header slot (dec-6/ac-24): the only text
// a dialog renders is its title, its load-bearing fields, the inline block reason,
// and its buttons. Anything longer than a phrase does not belong here.

import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface TagDialogShellProps {
  /** The dialog's accessible name — rendered as the only heading. */
  title: string;
  testId: string;
  onClose: () => void;
  children: ReactNode;
  /** The action row (Cancel + the confirm/delete button). */
  footer: ReactNode;
}

export function TagDialogShell({
  title,
  testId,
  onClose,
  children,
  footer,
}: TagDialogShellProps): React.ReactPortal {
  const panelRef = useRef<HTMLDivElement>(null);
  // The element focused when the dialog opened — restored on close so focus
  // returns to the trigger (ac-34). Captured once, before we move focus inward.
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    triggerRef.current = document.activeElement as HTMLElement | null;
    // Move focus into the dialog: an explicit [data-autofocus] target (the primary
    // input) if the dialog marks one, else the first focusable control, else the panel.
    const panel = panelRef.current;
    const preferred =
      panel?.querySelector<HTMLElement>('[data-autofocus]') ??
      panel?.querySelector<HTMLElement>(FOCUSABLE);
    (preferred ?? panel)?.focus();
    return () => {
      // Return focus to whatever opened us (guard against a detached node).
      const trigger = triggerRef.current;
      if (trigger && document.contains(trigger)) trigger.focus();
    };
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      // Focus trap: keep Tab cycling inside the panel.
      const panel = panelRef.current;
      if (!panel) return;
      const nodes = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (nodes.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  const titleId = `${testId}-title`;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        tabIndex={-1}
        className="w-full max-w-md rounded-xl border border-edge bg-panel shadow-2xl focus:outline-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-edge flex items-center justify-between">
          <h2 id={titleId} className="text-base font-semibold text-heading">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-muted hover:text-primary transition-colors"
          >
            <span aria-hidden="true" className="text-lg leading-none">
              ×
            </span>
          </button>
        </div>
        <div className="p-6 space-y-3">{children}</div>
        <div className="px-6 py-4 border-t border-edge flex items-center justify-end gap-2">
          {footer}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Split a `scope::value` / flat string into its parts — the client mirror of the
 *  server's parseTagInput, used by the create/rename dialogs to run the duplicate
 *  pre-check (case-insensitive) so the confirm can disable BEFORE a round-trip.
 *  Only the FIRST `::` separates; an empty scope collapses to a flat tag. */
export function parseTagString(raw: string): { scope: string | null; value: string } {
  const trimmed = raw.trim();
  const idx = trimmed.indexOf('::');
  if (idx === -1) return { scope: null, value: trimmed };
  const scope = trimmed.slice(0, idx).trim();
  const value = trimmed.slice(idx + 2).trim();
  return { scope: scope || null, value };
}

/** Format a structured tag back to its `scope::value` (or flat) string. */
export function formatTagString(tag: { scope: string | null; value: string }): string {
  return tag.scope === null ? tag.value : `${tag.scope}::${tag.value}`;
}

/** Find a catalogue tag that collides with `candidate` CASE-INSENSITIVELY on both
 *  scope and value — the client mirror of the server's duplicate guard (dec-8), so
 *  the create/rename confirm can block before a round-trip. `excludeId` skips the
 *  tag being renamed (renaming a tag to itself is not a duplicate). Returns the
 *  colliding tag (for the "A tag named …" reason) or null. */
export function findCiDuplicate<T extends { id: string; scope: string | null; value: string }>(
  tags: readonly T[],
  candidate: { scope: string | null; value: string },
  excludeId?: string,
): T | null {
  const cScope = candidate.scope?.toLowerCase() ?? null;
  const cValue = candidate.value.toLowerCase();
  return (
    tags.find(
      (t) =>
        t.id !== excludeId &&
        (t.scope?.toLowerCase() ?? null) === cScope &&
        t.value.toLowerCase() === cValue,
    ) ?? null
  );
}
