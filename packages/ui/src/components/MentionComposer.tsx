import { useEffect, useRef, useState } from 'react';
import { TextArea } from './ui/TextArea';
import { Button } from './ui';
import { searchMentionableMembers, type MentionableMember } from '../api/client';
import { activeMentionToken, replaceMentionToken } from '../utils/mentionToken';

// spec-320 (dec-4, ac-5): the comment composer with an @-mention typeahead over
// active org members and an "Assign to" control. Typing `@` opens a live, filterable
// dropdown of colleagues (substring on name or email); selecting one inserts the
// mention and tracks the user. The author may assign the comment to one of the
// mentioned people (assign = mention + ownership, dec-2). On submit the parent gets
// the content plus the chosen mention user ids and optional assignee.

export interface MentionSubmit {
  content: string;
  mentionUserIds: string[];
  assigneeUserId: string | null;
}

interface MentionComposerProps {
  placeholder?: string;
  submitting: boolean;
  onSubmit: (data: MentionSubmit) => Promise<void> | void;
}

const DEBOUNCE_MS = 150;

function personLabel(m: { name: string | null; email: string }): string {
  return m.name?.trim() || m.email;
}

export function MentionComposer({ placeholder = 'Add a comment...', submitting, onSubmit }: MentionComposerProps) {
  const [content, setContent] = useState('');
  const [caret, setCaret] = useState(0);
  const [mentions, setMentions] = useState<MentionableMember[]>([]);
  const [assigneeUserId, setAssigneeUserId] = useState<string | null>(null);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState<string | null>(null);
  const [results, setResults] = useState<MentionableMember[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);

  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const seqRef = useRef(0);

  // Recompute the active @-token whenever the text or caret moves.
  function syncToken(value: string, caretPos: number) {
    const token = activeMentionToken(value, caretPos);
    if (token) {
      setQuery(token.query);
      setOpen(true);
    } else {
      setQuery(null);
      setOpen(false);
    }
  }

  // Debounced member search for the active token query.
  useEffect(() => {
    if (query === null) return;
    const seq = ++seqRef.current;
    const handle = window.setTimeout(async () => {
      const members = await searchMentionableMembers(query);
      if (seqRef.current === seq) {
        // Don't re-offer someone already selected.
        const chosen = new Set(mentions.map((m) => m.userId));
        setResults(members.filter((m) => !chosen.has(m.userId)));
        setActiveIdx(0);
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [query, mentions]);

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    const caretPos = e.target.selectionStart ?? value.length;
    setContent(value);
    setCaret(caretPos);
    syncToken(value, caretPos);
  }

  function selectMember(m: MentionableMember) {
    const token = activeMentionToken(content, caret);
    if (token) {
      const { text, caret: nextCaret } = replaceMentionToken(content, token.start, caret, personLabel(m));
      setContent(text);
      setCaret(nextCaret);
      // Restore focus + caret after React commits the new value.
      requestAnimationFrame(() => {
        const el = textRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(nextCaret, nextCaret);
        }
      });
    }
    setMentions((prev) => (prev.some((p) => p.userId === m.userId) ? prev : [...prev, m]));
    setOpen(false);
    setQuery(null);
  }

  function removeMention(userId: string) {
    setMentions((prev) => prev.filter((m) => m.userId !== userId));
    if (assigneeUserId === userId) setAssigneeUserId(null);
  }

  async function submit() {
    if (!content.trim() || submitting) return;
    await onSubmit({
      content: content.trim(),
      mentionUserIds: mentions.map((m) => m.userId),
      assigneeUserId,
    });
    setContent('');
    setMentions([]);
    setAssigneeUserId(null);
    setOpen(false);
    setQuery(null);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (open && results.length > 0) {
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
        e.preventDefault();
        selectMember(results[activeIdx]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        setQuery(null);
        return;
      }
    }
    // Cmd/Ctrl+Enter submits (matches the prior composer); plain Enter is a newline.
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <div className="mt-3 space-y-2">
      <div className="relative">
        <TextArea
          ref={textRef}
          data-testid="comment-textarea"
          placeholder={placeholder}
          value={content}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
          rows={2}
          textAreaSize="compact"
        />
        {open && results.length > 0 && (
          <div
            role="listbox"
            data-testid="mention-typeahead"
            className="absolute z-20 mt-1 max-h-56 w-64 overflow-y-auto rounded-md border border-edge bg-panel py-1 shadow-lg"
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

      {/* Selected mentions + assign control */}
      {mentions.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap gap-1" data-testid="mention-chips">
            {mentions.map((m) => (
              <span
                key={m.userId}
                data-testid="mention-chip"
                data-user-id={m.userId}
                className="inline-flex h-6 items-center gap-1 rounded-full border border-edge bg-overlay pl-2 pr-1 text-[11px] text-heading"
              >
                @{personLabel(m)}
                <button
                  type="button"
                  aria-label={`Remove ${personLabel(m)}`}
                  onClick={() => removeMention(m.userId)}
                  className="text-muted hover:text-primary"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <label className="flex items-center gap-2 text-[11px] text-muted">
            Assign to
            <select
              data-testid="assign-select"
              value={assigneeUserId ?? ''}
              onChange={(e) => setAssigneeUserId(e.target.value || null)}
              className="rounded-sm border border-edge bg-panel px-1.5 py-0.5 text-[11px] text-heading"
            >
              <option value="">No one</option>
              {mentions.map((m) => (
                <option key={m.userId} value={m.userId}>
                  {personLabel(m)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <Button
        data-testid="comment-submit"
        type="button"
        onClick={() => void submit()}
        disabled={submitting || !content.trim()}
        className="w-full"
        size="sm"
      >
        {submitting ? 'Posting...' : 'Post'}
      </Button>
    </div>
  );
}
