import { useRef, useEffect } from 'react';

// spec-100: the comment composer, shown as a floating popover anchored at the
// selection (replaces the old gutter-card composer). Enter sends; Shift+Enter
// inserts a newline. Theme-aware via semantic tokens.

interface CommentComposerPopoverProps {
  top: number;
  left: number;
  value: string;
  submitting: boolean;
  error: string | null;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

export function CommentComposerPopover({
  top,
  left,
  value,
  submitting,
  error,
  onChange,
  onSubmit,
  onCancel,
}: CommentComposerPopoverProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Focus on open and grow the textarea to fit (so long comments wrap, design #3).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  const canSend = !submitting && value.trim().length > 0;

  return (
    <div
      data-testid="comment-composer"
      onClick={(e) => e.stopPropagation()}
      style={{ position: 'fixed', top, left, transform: 'translateX(-50%)', zIndex: 50, width: 320 }}
      className="rounded-xl border border-edge-subtle bg-surface shadow-lg px-3 py-2"
    >
      <div className="flex items-center gap-2">
        <textarea
          ref={ref}
          data-testid="comment-composer-text"
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              if (canSend) onSubmit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              onCancel();
            }
          }}
          placeholder="Add a comment…"
          className="flex-1 resize-none bg-transparent text-sm text-primary placeholder:text-muted focus:outline-none leading-6 max-h-[200px]"
        />
        <button
          type="button"
          data-testid="comment-composer-send"
          onClick={onSubmit}
          disabled={!canSend}
          aria-label="Send comment"
          title="Send comment"
          className="shrink-0 inline-flex items-center justify-center w-8 h-8 rounded-lg text-accent hover:bg-card-hover disabled:text-muted disabled:hover:bg-transparent transition-colors"
        >
          {/* paper-plane send */}
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.7}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.75 5.25l16.5 6.75-16.5 6.75L6 12zm0 0h6" />
          </svg>
        </button>
      </div>
      {error && <p className="mt-1 text-[11px] text-status-danger-text">{error}</p>}
    </div>
  );
}
