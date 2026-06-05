import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Tag } from '../api/types';
import { fetchMemexTags, setDocTags, removeDocTag } from '../api/client';
import { TagChip } from './TagChip';
import { parseTagInput, formatTagInput, tagKey, tagMatchesQuery } from '../utils/tagInput';

interface TagPickerProps {
  /** The Spec/doc the tags belong to. Writes target POST /api/docs/:id/tags. */
  docId: string;
  /** The doc's current tags (from the doc payload). Treated as the initial set. */
  tags: Tag[];
  /**
   * Called with the doc's full tag set after any apply/remove, so the parent can
   * keep its own copy (e.g. the doc payload) in sync without a refetch.
   */
  onTagsChange?: (tags: Tag[]) => void;
  className?: string;
}

/**
 * spec-136 t-6 (ac-1, ac-2): a type-ahead create-or-pick affordance for a Spec's
 * tags. Anyone who can see the Spec can tag it — there is NO admin step / role
 * gate (ac-1). The control:
 *   - shows the current tags as one-click-removable chips,
 *   - opens a dropdown that filters the Memex tag catalogue as you type,
 *   - applies an existing tag on click, OR creates a new one inline from the
 *     typed text when nothing matches (the `::` convention scopes it),
 *   - reflects per-scope mutual exclusivity (ac-2): assigning `priority::high`
 *     swaps out any existing `priority::*` because the server enforces it and
 *     returns the new full set, which we render. Flat tags are multi-valued.
 *
 * All writes ride the existing REST surface (setDocTags / removeDocTag); the
 * picker never constructs tag rows — it sends `scope::value`/flat strings and
 * renders the resolved Tag objects the server returns.
 */
export function TagPicker({ docId, tags, onTagsChange, className = '' }: TagPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [catalogue, setCatalogue] = useState<Tag[]>([]);
  const [catalogueLoaded, setCatalogueLoaded] = useState(false);
  const [catalogueError, setCatalogueError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const applyTags = useCallback(
    (next: Tag[]) => {
      onTagsChange?.(next);
    },
    [onTagsChange],
  );

  // Load the catalogue lazily the first time the dropdown opens — keeps the
  // Spec page render cheap when nobody touches tags.
  useEffect(() => {
    if (!open || catalogueLoaded) return;
    let cancelled = false;
    fetchMemexTags()
      .then((all) => {
        if (!cancelled) {
          setCatalogue(all);
          setCatalogueError(false);
          setCatalogueLoaded(true);
        }
      })
      .catch(() => {
        // Catalogue is an optimization for the type-ahead; inline-create still
        // works without it. Mark loaded so we don't spin on every keystroke, but
        // flag the error so the empty dropdown isn't mistaken for "no tags".
        if (!cancelled) {
          setCatalogueError(true);
          setCatalogueLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, catalogueLoaded]);

  // Close on outside click / Escape (mirrors SpecMenu / PhaseDropdown).
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (containerRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const appliedKeys = useMemo(() => new Set(tags.map(tagKey)), [tags]);

  // Catalogue entries that match the query and aren't already on the doc.
  const suggestions = useMemo(() => {
    return catalogue
      .filter((t) => !appliedKeys.has(tagKey(t)))
      .filter((t) => tagMatchesQuery(t, query));
  }, [catalogue, appliedKeys, query]);

  const parsed = useMemo(() => parseTagInput(query), [query]);

  // Offer inline-create only when the typed text is a valid tag and doesn't
  // exactly match something already in the catalogue or already applied.
  const exactExists = useMemo(() => {
    if (!parsed) return false;
    const key = tagKey(parsed);
    if (appliedKeys.has(key)) return true;
    return catalogue.some((t) => tagKey(t) === key);
  }, [parsed, appliedKeys, catalogue]);

  const canCreate = parsed !== null && !exactExists;

  const handleApply = useCallback(
    async (raw: string) => {
      const p = parseTagInput(raw);
      if (!p) return;
      setBusy(true);
      setError(null);
      try {
        const { tags: next } = await setDocTags(docId, [raw]);
        applyTags(next);
        // Fold any newly-coined tag into the catalogue so the type-ahead knows
        // about it immediately (the server returns the full applied set).
        setCatalogue((prev) => {
          const have = new Set(prev.map(tagKey));
          const additions = next.filter((t) => !have.has(tagKey(t)));
          return additions.length ? [...prev, ...additions] : prev;
        });
        setQuery('');
        inputRef.current?.focus();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to apply tag');
      } finally {
        setBusy(false);
      }
    },
    [docId, applyTags],
  );

  const handleRemove = useCallback(
    async (tag: Tag) => {
      setBusy(true);
      setError(null);
      try {
        const { tags: next } = await removeDocTag(docId, tag.id);
        applyTags(next);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to remove tag');
      } finally {
        setBusy(false);
      }
    },
    [docId, applyTags],
  );

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      // Enter applies the first suggestion if there is one, else creates the
      // typed tag (ac-1 inline create).
      if (suggestions.length > 0) {
        void handleApply(formatTagInput(suggestions[0]));
      } else if (canCreate) {
        void handleApply(query);
      }
    }
  };

  return (
    <div
      ref={containerRef}
      className={`relative inline-flex flex-wrap items-center gap-1.5 ${className}`}
      data-testid="tag-picker"
    >
      {tags.map((tag) => (
        <TagChip
          key={tag.id}
          tag={tag}
          // spec-159: the picker sits on the Spec byline — h-6 keeps the tag
          // chips the same height as the assignee chips + "+ Assign"/"+ Tag".
          className="h-6"
          onRemove={busy ? undefined : () => void handleRemove(tag)}
          removeLabel={`Remove tag ${formatTagInput(tag)}`}
        />
      ))}

      <button
        type="button"
        data-testid="tag-picker-add"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setOpen((v) => !v);
          // Defer focus so the input has mounted.
          setTimeout(() => inputRef.current?.focus(), 0);
        }}
        className="inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-edge-subtle px-2 text-[11px] font-medium leading-none text-secondary hover:border-edge-strong hover:text-primary transition-colors"
      >
        <span aria-hidden="true" className="text-[13px] leading-none">+</span>
        <span>Tag</span>
      </button>

      {open && (
        <div
          role="listbox"
          data-testid="tag-picker-dropdown"
          className="absolute top-full left-0 z-50 mt-1 w-64 rounded-lg border border-edge bg-panel shadow-xl"
        >
          <div className="p-2 border-b border-edge-subtle">
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleInputKeyDown}
              placeholder="Filter or add a tag (scope::value)"
              data-testid="tag-picker-input"
              aria-label="Filter or add a tag"
              className="w-full bg-input border border-edge text-primary placeholder-muted focus:outline-none focus:ring-1 focus:ring-edge-strong focus:border-edge-strong px-2 py-1 text-xs rounded"
            />
            {/* ac-2 hint: scoped tags swap within their scope; flat tags stack. */}
            <p className="mt-1 text-[10px] leading-tight text-muted">
              Use <code className="font-mono">scope::value</code> to scope a tag — one value per scope.
            </p>
          </div>

          <div className="max-h-56 overflow-y-auto py-1">
            {suggestions.map((t) => (
              <button
                key={t.id}
                type="button"
                role="option"
                aria-selected={false}
                data-testid="tag-picker-option"
                disabled={busy}
                onClick={() => void handleApply(formatTagInput(t))}
                className="w-full flex items-center px-2 py-1.5 text-left hover:bg-overlay disabled:opacity-50"
              >
                <TagChip tag={t} />
              </button>
            ))}

            {canCreate && (
              <button
                type="button"
                role="option"
                aria-selected={false}
                data-testid="tag-picker-create"
                disabled={busy}
                onClick={() => void handleApply(query)}
                className="w-full flex items-center gap-2 px-2 py-1.5 text-left text-xs text-secondary hover:bg-overlay hover:text-primary disabled:opacity-50"
              >
                <span className="text-muted">Create</span>
                {parsed && <TagChip tag={parsed} />}
              </button>
            )}

            {suggestions.length === 0 && !canCreate && (
              <div className="px-2 py-2 text-xs text-muted text-center">
                {!catalogueLoaded
                  ? 'Loading tags…'
                  : catalogueError
                    ? "Couldn't load existing tags — you can still type one to create it"
                    : 'No matching tags'}
              </div>
            )}
          </div>

          {error && (
            <div className="px-2 py-1.5 text-[11px] text-status-danger-text border-t border-edge-subtle">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
