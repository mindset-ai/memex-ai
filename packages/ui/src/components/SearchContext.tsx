import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { SearchPalette } from './SearchPalette';

// spec-192 t-1 (ac-2 / ac-8 / ac-10): the global ⌘K search open-state lives here
// so the app chrome — the Specs board header (SpecList) and the doc-page header
// (AppShell) — can open the SAME palette instance the keyboard shortcut toggles.
// One palette, one source of truth: a single <SearchPalette> mount and a single
// `open` boolean, exposed to the chrome via `openSearch()` on this context.
//
// Lifted verbatim out of spec-64's GlobalSearchHost (App.tsx): the ⌘K / Ctrl K
// keydown listener (spec-64 ac-16) and the open/close focus-restoration
// (spec-64 ac-8) are preserved unchanged — only their home moved from a leaf host
// to this provider so the open-state is reachable from the chrome above the
// router. SearchPalette's controlled `open`/`onOpenChange` contract is unchanged.

interface SearchContextValue {
  /** Whether the command palette is currently open. */
  open: boolean;
  /** Open the palette (the chrome triggers + the ⌘K shortcut all call this). */
  openSearch: () => void;
  /** Close the palette. */
  closeSearch: () => void;
}

const SearchContext = createContext<SearchContextValue | null>(null);

// Returns the palette controls, or null when called outside a SearchProvider
// (e.g. an isolated component test that renders a trigger without the provider).
// Callers null-guard so a trigger renders inertly rather than throwing.
export function useSearch(): SearchContextValue | null {
  return useContext(SearchContext);
}

export function SearchProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // spec-64 ac-8: the palette opens programmatically (no Radix Dialog.Trigger),
  // so Radix has nothing to restore focus to on close — it would fall to <body>.
  // Capture the focused element on open and hand it back on close, whether the
  // close came from Esc, an overlay click, a ⌘K toggle, or a trigger click.
  const setOpenSafe = useCallback((next: boolean) => {
    if (next && !openRef.current) {
      restoreFocusRef.current = document.activeElement as HTMLElement | null;
    }
    openRef.current = next;
    setOpen(next);
    if (!next) {
      const el = restoreFocusRef.current;
      restoreFocusRef.current = null;
      // Restore on the next frame, after Radix's own close-autofocus (which
      // targets the absent trigger) has run — so our restore wins.
      if (el && typeof el.focus === 'function') {
        requestAnimationFrame(() => el.focus());
      }
    }
  }, []);

  // spec-64 ac-16: the app-level ⌘K / Ctrl K hotkey. A thin window listener owns
  // the shortcut and preventDefault()s so the browser/cmdk never sees it; it
  // toggles the single open-state. Mounted app-wide so the omnibox is reachable
  // from any route.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setOpenSafe(!openRef.current);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setOpenSafe]);

  const openSearch = useCallback(() => setOpenSafe(true), [setOpenSafe]);
  const closeSearch = useCallback(() => setOpenSafe(false), [setOpenSafe]);

  return (
    <SearchContext.Provider value={{ open, openSearch, closeSearch }}>
      {children}
      <SearchPalette open={open} onOpenChange={setOpenSafe} />
    </SearchContext.Provider>
  );
}
