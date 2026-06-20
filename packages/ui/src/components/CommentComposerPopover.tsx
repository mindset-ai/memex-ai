import { useRef, useEffect, useState } from 'react';
import { useMentionSearch } from '../hooks/useMentionSearch';
import { activeMentionToken, replaceMentionToken } from '../utils/mentionToken';
import type { MentionableMember } from '../api/client';

// spec-100: the comment composer, shown as a floating popover anchored at the
// selection (replaces the old gutter-card composer). Enter sends; Shift+Enter
// inserts a newline. Theme-aware via semantic tokens.
//
// spec-320 (dec-4): this is the PRINCIPAL place comments are added (inline on a
// section passage), so it carries the @-mention typeahead. Typing `@` opens a live
// dropdown of active org members (substring on name / email); selecting one inserts
// the mention and tracks the user, and the chosen mentions ride the submit so the
// comment notifies them.

interface CommentComposerPopoverProps {
  top: number;
  left: number;
  value: string;
  submitting: boolean;
  error: string | null;
  onChange: (v: string) => void;
  /** Reports the @-mentioned user ids alongside the submit (spec-320). */
  onSubmit: (mentionUserIds: string[]) => void;
  onCancel: () => void;
}

function personLabel(m: { name: string | null; email: string }): string {
  return m.name?.trim() || m.email;
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

  // spec-320 typeahead state. `caret` locates the active `@`-token; `mentions` are
  // the selected members reported on submit; `dismissed` lets Escape close the
  // dropdown without cancelling the whole composer.
  const [caret, setCaret] = useState(0);
  const [mentions, setMentions] = useState<MentionableMember[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  const token = activeMentionToken(value, caret);
  const chosen = new Set(mentions.map((m) => m.userId));
  const results = useMentionSearch(token ? token.query : null).filter((m) => !chosen.has(m.userId));
  const open = token !== null && results.length > 0 && !dismissed;

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

  const selectMember = (m: MentionableMember) => {
    const tok = activeMentionToken(value, caret);
    if (tok) {
      const { text, caret: nextCaret } = replaceMentionToken(value, tok.start, caret, personLabel(m));
      onChange(text);
      setCaret(nextCaret);
      requestAnimationFrame(() => {
        const el = ref.current;
        if (el) {
          el.focus();
          el.setSelectionRange(nextCaret, nextCaret);
        }
      });
    }
    setMentions((prev) => (prev.some((p) => p.userId === m.userId) ? prev : [...prev, m]));
    setActiveIdx(0);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => (i + 1) % results.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => (i - 1 + results.length) % results.length);
        return;
      }
      if (e.key === 'Enter') {
        // While the typeahead is open, Enter picks the active member — it does NOT
        // send (so an @-mention can't accidentally submit a half-typed comment).
        e.preventDefault();
        selectMember(results[activeIdx]!);
        return;
      }
      if (e.key === 'Escape') {
        // Close the dropdown but keep the composer open + the draft intact.
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (canSend) onSubmit(mentions.map((m) => m.userId));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div
      data-testid="comment-composer"
      onClick={(e) => e.stopPropagation()}
      style={{ position: 'fixed', top, left, transform: 'translateX(-50%)', zIndex: 50, width: 320 }}
      className="rounded-xl border border-edge-subtle bg-surface shadow-lg px-3 py-2"
    >
      <div className="relative">
        <div className="flex items-center gap-2">
          <textarea
            ref={ref}
            data-testid="comment-composer-text"
            rows={1}
            value={value}
            onChange={(e) => {
              onChange(e.target.value);
              setCaret(e.target.selectionStart ?? e.target.value.length);
              setDismissed(false);
            }}
            onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
            onKeyDown={handleKeyDown}
            placeholder="Add a comment… use @ to mention"
            className="flex-1 resize-none bg-transparent text-sm text-primary placeholder:text-muted focus:outline-hidden leading-6 max-h-[200px]"
          />
          <button
            type="button"
            data-testid="comment-composer-send"
            onClick={() => onSubmit(mentions.map((m) => m.userId))}
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

        {open && (
          <div
            role="listbox"
            data-testid="mention-typeahead"
            className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-md border border-edge bg-panel py-1 shadow-lg"
          >
            {results.map((m, i) => (
              <button
                key={m.userId}
                type="button"
                role="option"
                aria-selected={i === activeIdx}
                data-testid="mention-option"
                data-user-id={m.userId}
                onMouseDown={(e) => {
                  // mousedown (not click) so the textarea doesn't blur first.
                  e.preventDefault();
                  selectMember(m);
                }}
                className={`flex w-full flex-col items-start px-3 py-1.5 text-left text-xs ${
                  i === activeIdx ? 'bg-overlay' : ''
                } hover:bg-overlay`}
              >
                <span className="text-heading">{personLabel(m)}</span>
                {m.name && <span className="text-[10px] text-muted">{m.email}</span>}
              </button>
            ))}
          </div>
        )}
      </div>

      {mentions.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1" data-testid="mention-chips">
          {mentions.map((m) => (
            <span
              key={m.userId}
              data-testid="mention-chip"
              data-user-id={m.userId}
              className="inline-flex h-5 items-center gap-1 rounded-full border border-edge bg-overlay pl-2 pr-1 text-[10px] text-heading"
            >
              @{personLabel(m)}
              <button
                type="button"
                aria-label={`Remove ${personLabel(m)}`}
                onClick={() => setMentions((prev) => prev.filter((x) => x.userId !== m.userId))}
                className="text-muted hover:text-primary"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {error && <p className="mt-1 text-[11px] text-status-danger-text">{error}</p>}
    </div>
  );
}
