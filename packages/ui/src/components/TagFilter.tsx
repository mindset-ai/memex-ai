import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Tag } from '../api/types';
import { fetchMemexTags } from '../api/client';
import { TagChip } from './TagChip';
import { formatTagInput, tagMatchesQuery, parseTagInput } from '../utils/tagInput';
import { tenantPath } from '../utils/tenantUrl';
import { useTelemetry } from '../hooks/useTelemetry';

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
  const { track } = useTelemetry(true);
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

  // Every selection change goes through here so the telemetry fires once per
  // change (count only — never the tag values, std-35 cl-5).
  const applyChange = useCallback(
    (next: string[]) => {
      track('board.tag_filter_applied', { filterCount: next.length });
      onChange(next);
    },
    [onChange, track],
  );

  const toggle = useCallback(
    (raw: string) => {
      if (selectedSet.has(raw)) {
        applyChange(selected.filter((s) => s !== raw));
      } else {
        applyChange([...selected, raw]);
      }
    },
    [selected, selectedSet, applyChange],
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
            onClick={() => applyChange([])}
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
              className="w-full bg-input border border-edge text-primary placeholder-muted focus:outline-hidden focus:ring-1 focus:ring-edge-strong focus:border-edge-strong px-2 py-1 text-xs rounded-sm"
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
                    isSelected ? 'bg-overlay' : ''
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`flex h-3.5 w-3.5 flex-none items-center justify-center rounded-sm border text-[10px] ${
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

          {/* spec-418 t-5 (ac-9): the SINGLE entry point to the Manage-tags surface.
              Path-based nav to the tenant `/specs/tags` page (dec-1) — there is no
              nav item and no board-header mirror; this dropdown row is the only door. */}
          <div className="border-t border-edge-subtle p-1">
            <Link
              to={tenantPath('/specs/tags')}
              data-testid="tag-filter-manage"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 rounded-sm px-2 py-1.5 text-xs text-secondary hover:bg-overlay hover:text-primary"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.343 3.94c.09-.542.56-.94 1.11-.94h1.093c.55 0 1.02.398 1.11.94l.149.894c.07.424.384.764.78.93.398.164.855.142 1.205-.108l.737-.527a1.125 1.125 0 011.45.12l.773.774c.39.389.44 1.002.12 1.45l-.527.737c-.25.35-.272.806-.107 1.204.165.397.505.71.93.78l.893.15c.543.09.94.56.94 1.109v1.094c0 .55-.397 1.02-.94 1.11l-.893.149c-.425.07-.765.383-.93.78-.165.398-.143.854.107 1.204l.527.738c.32.447.269 1.06-.12 1.45l-.774.773a1.125 1.125 0 01-1.449.12l-.738-.527c-.35-.25-.806-.272-1.203-.107-.397.165-.71.505-.781.929l-.149.894c-.09.542-.56.94-1.11.94h-1.094c-.55 0-1.019-.398-1.11-.94l-.148-.894c-.071-.424-.384-.764-.781-.93-.398-.164-.854-.142-1.204.108l-.738.527c-.447.32-1.06.269-1.45-.12l-.773-.774a1.125 1.125 0 01-.12-1.45l.527-.737c.25-.35.273-.806.108-1.204-.165-.397-.505-.71-.93-.78l-.894-.15c-.542-.09-.94-.56-.94-1.109v-1.094c0-.55.398-1.02.94-1.11l.894-.149c.424-.07.765-.383.93-.78.165-.398.143-.854-.108-1.204l-.526-.738a1.125 1.125 0 01.12-1.45l.773-.773a1.125 1.125 0 011.45-.12l.737.527c.35.25.807.272 1.204.107.397-.165.71-.505.78-.929l.15-.894z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              <span>Manage tags</span>
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
