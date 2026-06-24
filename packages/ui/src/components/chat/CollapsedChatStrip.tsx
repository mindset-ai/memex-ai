// spec-389: the agent panel's CLOSED state — a thin vertical strip that the
// agent collapses to, clickable anywhere to reopen. Same interaction as the Spec
// board's collapsed "Done" column (SpecList): a `w-12` rail with a vertical
// label, here fronted by a chat glyph so it reads as "the agent, tucked away".
// The whole strip is the button (generous hit area); a chevron hints it opens
// rightward into the panel.

interface CollapsedChatStripProps {
  /** Reopen the panel. */
  onExpand: () => void;
  /** Vertical label, e.g. 'Standards', 'Drift', 'Assistant'. Default 'Agent'. */
  label?: string;
  /** Optional testid on the strip button. */
  testId?: string;
}

export function CollapsedChatStrip({
  onExpand,
  label = 'Agent',
  testId,
}: CollapsedChatStripProps) {
  return (
    <button
      type="button"
      onClick={onExpand}
      data-testid={testId}
      aria-label={`Open the ${label} agent panel`}
      title={`Open the ${label} agent`}
      className="hidden md:flex w-12 flex-none flex-col items-center justify-start gap-3 py-3 border-r border-edge bg-surface/40 hover:bg-surface/60 text-muted hover:text-secondary transition-colors"
    >
      {/* Chat glyph — marks the strip as the agent (not a generic panel). */}
      <svg className="w-4 h-4 flex-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M8 10h8M8 14h5M21 12a8 8 0 01-8 8H7l-4 3v-7a8 8 0 018-8h2a8 8 0 018 4z" />
      </svg>
      <span className="text-xs font-medium uppercase tracking-wider [writing-mode:vertical-rl] rotate-180">
        {label}
      </span>
      {/* Chevron — hints the strip opens rightward into the panel. */}
      <svg className="w-3.5 h-3.5 flex-none mt-auto" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
      </svg>
    </button>
  );
}
