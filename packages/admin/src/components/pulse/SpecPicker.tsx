// SpecPicker — the searchable Spec selector in the Pulse header (b-60, dec-9).
//
// Trigger reads `[Spec: all ▾]` when nothing is selected, or `[Spec: <title> ▾]`
// when scoped to one Spec. Opening it reveals a search box + filtered list plus a
// standing "All Specs" row that clears the filter.
//
// PRESENTATIONAL. The page owns the fetch and passes `specs`; selecting a Spec
// (or clearing) calls `onChange(specHandle | null)`, and the page reflects that
// into the `?spec=` route param. This component holds only ephemeral open/search/
// keyboard-focus state — never the canonical selection, never the router.
//
// Built on the same portal + role="listbox"/"option" pattern as PhaseDropdown
// (there's no shared combobox primitive in the app) with a text Input layered on
// top for filtering — see ui/Input.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Input } from '../ui/Input';

export interface SpecPickerSpec {
  /** Stable Spec handle (the value reflected into `?spec=`). */
  handle: string;
  /** Display title. */
  title: string;
}

export interface SpecPickerProps {
  /** Selected Spec handle, or null for "all Specs". */
  value: string | null;
  /** Fired with a handle to scope, or null to clear back to all. */
  onChange: (specHandle: string | null) => void;
  /** Specs to choose from — the page owns the fetch. */
  specs: SpecPickerSpec[];
  /** Whether the spec list is still loading. */
  loading?: boolean;
}

// Sentinel index for the always-present "All Specs" row, which sits above the
// filtered Spec options in the keyboard-navigation order.
const ALL_INDEX = -1;

export function SpecPicker({ value, onChange, specs, loading = false }: SpecPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [focusedIndex, setFocusedIndex] = useState<number>(ALL_INDEX);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const selectedSpec = useMemo(
    () => specs.find((b) => b.handle === value) ?? null,
    [specs, value],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return specs;
    return specs.filter(
      (b) => b.title.toLowerCase().includes(q) || b.handle.toLowerCase().includes(q),
    );
  }, [specs, query]);

  // Position the portalled menu under the trigger. Recompute whenever it opens.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    setMenuPos({
      top: rect.bottom + 4,
      left: rect.left,
      width: Math.max(rect.width, 240),
    });
  }, [open]);

  // On open: reset the query, focus the search box, and park keyboard focus on
  // the "All Specs" row.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setFocusedIndex(ALL_INDEX);
    const id = window.setTimeout(() => searchRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  // Keep the highlighted row in range as the filtered list shrinks while typing.
  useEffect(() => {
    if (focusedIndex >= filtered.length) setFocusedIndex(ALL_INDEX);
  }, [filtered.length, focusedIndex]);

  // Click-outside + Escape close the menu, returning focus to the trigger.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function selectHandle(handle: string | null) {
    onChange(handle);
    close();
  }

  // Keyboard nav lives on the search input so typing and arrowing share focus.
  // Index -1 is the "All Specs" row; 0..n-1 map to `filtered`.
  function onSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusedIndex((i) => Math.min(i + 1, filtered.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusedIndex((i) => Math.max(i - 1, ALL_INDEX));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (focusedIndex === ALL_INDEX) {
        selectHandle(null);
        return;
      }
      const spec = filtered[focusedIndex];
      if (spec) selectHandle(spec.handle);
    }
  }

  const triggerLabel = selectedSpec ? selectedSpec.title : 'all';

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={
          selectedSpec
            ? `Filtering activity to Spec: ${selectedSpec.title}. Click to change.`
            : 'Filtering activity to all Specs. Click to change.'
        }
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-full border border-edge bg-input px-2.5 py-0.5 text-xs font-medium text-secondary transition-colors hover:text-primary hover:bg-overlay focus:outline-none focus-visible:ring-1 focus-visible:ring-edge-strong"
      >
        <span className="text-muted">Spec:</span>
        <span className="truncate max-w-[12rem] text-primary">{triggerLabel}</span>
        <svg className="h-3 w-3 opacity-70" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open &&
        menuPos &&
        createPortal(
          <div
            ref={menuRef}
            style={{ top: menuPos.top, left: menuPos.left, width: menuPos.width }}
            className="fixed z-50 rounded-lg border border-edge bg-panel shadow-xl"
          >
            <div className="border-b border-edge-subtle p-2">
              <Input
                ref={searchRef}
                inputSize="compact"
                type="text"
                role="combobox"
                aria-expanded={open}
                aria-controls="spec-picker-listbox"
                aria-label="Search Specs"
                placeholder="Search Specs…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onSearchKeyDown}
              />
            </div>

            <div
              id="spec-picker-listbox"
              role="listbox"
              aria-label="Specs"
              className="max-h-72 overflow-y-auto py-1"
            >
              {/* Standing "All Specs" row — clears the filter. */}
              <button
                type="button"
                role="option"
                aria-selected={value === null}
                onClick={() => selectHandle(null)}
                onMouseEnter={() => setFocusedIndex(ALL_INDEX)}
                className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
                  focusedIndex === ALL_INDEX
                    ? 'bg-overlay text-primary'
                    : 'text-secondary hover:bg-overlay hover:text-primary'
                }`}
              >
                <span className="font-medium">All Specs</span>
                {value === null && <span className="text-[10px] uppercase text-muted">current</span>}
              </button>

              <div className="my-1 border-t border-edge-subtle" />

              {loading ? (
                <div className="px-3 py-2 text-sm text-muted">Loading Specs…</div>
              ) : filtered.length === 0 ? (
                <div className="px-3 py-2 text-sm text-muted">
                  {query.trim() ? 'No matching Specs' : 'No Specs'}
                </div>
              ) : (
                filtered.map((spec, i) => {
                  const selected = spec.handle === value;
                  const focused = i === focusedIndex;
                  return (
                    <button
                      key={spec.handle}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      onClick={() => selectHandle(spec.handle)}
                      onMouseEnter={() => setFocusedIndex(i)}
                      className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
                        focused
                          ? 'bg-overlay text-primary'
                          : selected
                          ? 'text-primary'
                          : 'text-secondary hover:bg-overlay hover:text-primary'
                      }`}
                    >
                      <span className="truncate">{spec.title}</span>
                      {selected && <span className="text-[10px] uppercase text-muted">current</span>}
                    </button>
                  );
                })
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
