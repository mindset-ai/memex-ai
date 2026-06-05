import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Tag } from '../api/types';
import { fetchMemexTags } from '../api/client';
import { TagChip } from './TagChip';
import { formatTagInput, tagMatchesQuery, parseTagInput } from '../utils/tagInput';

interface TagFilterProps {
  /**
   * Currently-selected filter tags as `scope::value`/flat strings (the exact
   * shape `fetchDocs({ tags })` wants). Controlled by the parent board.
   */
  selected: string[];
  /** Called with the next selection whenever a tag is toggled or all are cleared. */
  onChange: (next: string[]) => void;
  className?: string;
}

/**
 * spec-136 t-7 (ac-3): a multi-select tag filter for the Specs board. Picking
 * tags narrows the board to Specs carrying them; the selection is clearable.
 *
 * Facet semantics (surfaced in the dropdown + mirrored by the server):
 *   - AND across scopes — a Spec must match every scope you've picked from.
 *   - OR within a scope — picking `priority::high` + `priority::low` matches
 *     either value of `priority`.
 * The selected strings are passed straight to `fetchDocs({ tags })`; the server
 * applies the same AND/OR semantics on the indexed (scope, value) join.
 */
export function TagFilter({ selected, onChange, className = '' }: TagFilterProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [catalogue, setCatalogue] = useState<Tag[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Load the catalogue the first time the dropdown opens.
  useEffect(() => {
    if (!open || loaded) return;
    let cancelled = false;
    fetchMemexTags()
      .then((all) => {
        if (!cancelled) {
          setCatalogue(all);
          setLoadError(false);
          setLoaded(true);
        }
      })
      .catch(() => {
        // Surface the failure rather than silently showing an empty dropdown —
        // an empty list because of an error reads identically to "no tags yet".
        if (!cancelled) {
          setLoadError(true);
          setLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, loaded]);

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

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const toggle = useCallback(
    (raw: string) => {
      if (selectedSet.has(raw)) {
        onChange(selected.filter((s) => s !== raw));
      } else {
        onChange([...selected, raw]);
      }
    },
    [selected, selectedSet, onChange],
  );

  const visible = useMemo(
    () => catalogue.filter((t) => tagMatchesQuery(t, query)),
    [catalogue, query],
  );

  // Render the selected chips even if the catalogue hasn't loaded — parse the
  // raw strings into {scope, value} for display via the shared formatter.
  const selectedTags = useMemo(
    // Reuse the shared parser instead of re-implementing the `::` split (avoids drift
    // with the server's parseTagInput). Fall back to a flat tag for any odd input.
    () => selected.map((raw) => parseTagInput(raw) ?? { scope: null, value: raw }),
    [selected],
  );

  return (
    <div ref={containerRef} className={`relative ${className}`} data-testid="tag-filter">
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="tag-filter-toggle"
          aria-haspopup="listbox"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-1.5 rounded-md border border-edge-subtle px-2 py-1 text-xs text-secondary hover:border-edge-strong hover:text-primary transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 4h18M6 10h12M10 16h4" />
          </svg>
          <span>Filter by tag</span>
          {selected.length > 0 && (
            <span
              data-testid="tag-filter-count"
              className="ml-0.5 inline-flex items-center justify-center rounded-full bg-overlay px-1.5 text-[10px] tabular-nums text-primary"
            >
              {selected.length}
            </span>
          )}
        </button>

        {selected.length > 0 && (
          <button
            type="button"
            data-testid="tag-filter-clear"
            onClick={() => onChange([])}
            className="text-xs text-muted hover:text-secondary underline-offset-2 hover:underline"
          >
            Clear
          </button>
        )}
      </div>

      {/* Selected chips render inline so the active filter is visible without
          opening the dropdown. Each chip is removable. */}
      {selectedTags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1" data-testid="tag-filter-selected">
          {selectedTags.map((t, i) => {
            const raw = selected[i];
            return (
              <TagChip
                key={raw}
                tag={t}
                onRemove={() => toggle(raw)}
                removeLabel={`Remove filter ${formatTagInput(t)}`}
              />
            );
          })}
        </div>
      )}

      {open && (
        <div
          role="listbox"
          data-testid="tag-filter-dropdown"
          className="absolute top-full left-0 z-50 mt-1 w-64 rounded-lg border border-edge bg-panel shadow-xl"
        >
          <div className="p-2 border-b border-edge-subtle">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter tags…"
              data-testid="tag-filter-search"
              aria-label="Filter tags"
              className="w-full bg-input border border-edge text-primary placeholder-muted focus:outline-none focus:ring-1 focus:ring-edge-strong focus:border-edge-strong px-2 py-1 text-xs rounded"
            />
            {/* ac-3: spell out the AND-across-scopes / OR-within-scope semantics. */}
            <p className="mt-1 text-[10px] leading-tight text-muted">
              Matches Specs with <strong>all</strong> chosen scopes; within a scope <strong>any</strong> value matches.
            </p>
          </div>

          <div className="max-h-56 overflow-y-auto py-1">
            {visible.map((t) => {
              const raw = formatTagInput(t);
              const isSelected = selectedSet.has(raw);
              return (
                <button
                  key={t.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  data-testid="tag-filter-option"
                  onClick={() => toggle(raw)}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-overlay ${
                    isSelected ? 'bg-overlay/60' : ''
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`flex h-3.5 w-3.5 flex-none items-center justify-center rounded border text-[10px] ${
                      isSelected
                        ? 'border-edge-strong bg-edge-strong text-white'
                        : 'border-edge'
                    }`}
                  >
                    {isSelected ? '✓' : ''}
                  </span>
                  <TagChip tag={t} />
                </button>
              );
            })}

            {visible.length === 0 && (
              <div className="px-2 py-2 text-xs text-muted text-center">
                {!loaded ? 'Loading tags…' : loadError ? "Couldn't load tags" : 'No tags yet'}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
