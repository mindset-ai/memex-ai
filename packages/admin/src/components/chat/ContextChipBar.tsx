import { useChat } from '../ChatContext';

// Inline "Referring to:" row above the chat input. The state model holds at
// most one focus at a time (see ChatContext.addContextChip), so this renders
// a single row rather than a wrap of pills — the user is referring to one
// thing per message.
export function ContextChipBar() {
  const { contextChips, removeContextChip } = useChat();

  if (contextChips.length === 0) return null;
  const chip = contextChips[0];

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-t border-edge text-xs text-secondary">
      <svg className="w-3.5 h-3.5 shrink-0 opacity-70" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <span className="shrink-0">Referring to:</span>
      <span className="truncate font-medium text-primary">{chip.label}</span>
      <button
        onClick={() => removeContextChip(chip.id)}
        aria-label="Clear focus"
        className="ml-auto shrink-0 opacity-60 hover:opacity-100 transition-opacity"
      >
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
