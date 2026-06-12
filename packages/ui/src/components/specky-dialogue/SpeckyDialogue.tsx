// spec-242 t-1 (dec-1) — the reusable Specky text-dialogue surface.
//
// Specky's "text voice": a NON-modal rounded card docked bottom-right, directly
// above the VoiceLayer Specky avatar (which stays the face, in its idle loop —
// dec-3; this card renders no second Specky). No scrim, no portal — the board
// behind stays fully interactive (ac-7). The design is Figma "Specky Dialog",
// node 590-1855.
//
// It takes a pages[] model and runs them as a paged sequence: non-final pages
// show a footer "Next" link, the final page shows "Close", which ends the
// sequence (ac-8). Each page carries a heading in Specky's voice, short body
// content, and at most two actions — one dark primary, one quiet secondary
// (dec-1). First consumers: the first-run sequence here (spec-242) and the
// mic-priming page (spec-229).

import { useCallback, useState, type ReactNode } from 'react';

export interface SpeckyDialogueAction {
  label: string;
  onSelect: () => void;
  /** Optional leading icon (e.g. the mic glyph on spec-229's Turn on Mic). */
  icon?: ReactNode;
  /** 'primary' (dark filled button) | 'quiet' (text button). Default 'primary'. */
  kind?: 'primary' | 'quiet';
  testId?: string;
}

export interface SpeckyDialoguePage {
  /** Stable key for the page (also used in test ids). */
  key: string;
  heading: ReactNode;
  body: ReactNode;
  /** At most two actions render (dec-1); extras are dropped. */
  actions?: SpeckyDialogueAction[];
}

export interface SpeckyDialogueProps {
  pages: SpeckyDialoguePage[];
  /** Fired when the final page's Close is pressed — ends the sequence. */
  onClose: () => void;
  /** Optional observer for page advances (0-based index of the new page). */
  onPageChange?: (index: number) => void;
}

export function SpeckyDialogue({ pages, onClose, onPageChange }: SpeckyDialogueProps) {
  const [index, setIndex] = useState(0);
  const page = pages[index];
  const isFinal = index >= pages.length - 1;

  const advance = useCallback(() => {
    if (isFinal) {
      onClose();
      return;
    }
    const next = index + 1;
    setIndex(next);
    onPageChange?.(next);
  }, [index, isFinal, onClose, onPageChange]);

  if (!page) return null;

  return (
    // Non-modal by design (dec-1): role=complementary, NOT role=dialog — there is
    // no focus trap and nothing behind it is inert. Docked above the bottom-6
    // VoiceLayer avatar (24px + 40px icon + gap → bottom-20).
    <section
      role="complementary"
      aria-label="Specky"
      data-testid="specky-dialogue"
      data-specky-dialogue-page={page.key}
      className="fixed bottom-20 right-6 z-50 w-[min(480px,calc(100vw-3rem))] rounded-2xl border border-edge bg-surface p-8 shadow-2xl"
    >
      <h2 className="text-lg font-semibold text-heading">{page.heading}</h2>
      <div className="mt-4 text-sm text-primary">{page.body}</div>

      {page.actions && page.actions.length > 0 && (
        <div className="mt-5 flex items-center gap-3">
          {page.actions.slice(0, 2).map((action) => (
            <button
              key={action.label}
              type="button"
              data-testid={action.testId}
              onClick={action.onSelect}
              className={
                action.kind === 'quiet'
                  ? 'rounded-lg px-3 py-2 text-sm font-medium text-secondary hover:bg-card-hover'
                  : 'inline-flex items-center gap-2 rounded-lg bg-btn-primary px-3 py-2 text-sm font-medium text-white hover:bg-btn-primary-hover'
              }
            >
              {action.icon}
              {action.label}
            </button>
          ))}
        </div>
      )}

      <div className="mt-6 flex justify-end">
        <button
          type="button"
          data-testid="specky-dialogue-footer"
          onClick={advance}
          className="text-sm font-medium text-secondary hover:text-heading"
        >
          {isFinal ? 'Close' : 'Next'}
        </button>
      </div>
    </section>
  );
}
