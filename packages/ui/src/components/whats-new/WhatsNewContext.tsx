// spec-200 (follow-up): shared coordination between the What's New ribbon (rendered
// high in App.tsx) and the user menu in the sidebar (AppShell). The ribbon and the
// menu live in different parts of the tree, so they talk through this context:
//
//  • the menu's "What's New" item calls openPopup() to re-open the popup even after
//    the ribbon has been dismissed (req 5);
//  • the menu registers its anchor element so the ribbon can animate "into" it on
//    dismiss (req 4 — the fly-home animation reads getMenuAnchor());
//  • the ribbon reports `available` so the menu only shows the item when a feed
//    actually exists.
//
// The default value is a no-op so components (AppShell) can consume it unconditionally
// in tests that don't mount the provider.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

interface WhatsNewContextValue {
  /** True when at least one feed entry exists — gates the menu item. */
  available: boolean;
  /** The ribbon reports feed availability here. */
  setAvailable: (v: boolean) => void;
  /** Open the What's New popup (used by the sidebar menu item). */
  openPopup: () => void;
  /** The ribbon registers the handler that openPopup() invokes. */
  registerOpener: (fn: (() => void) | null) => void;
  /** The sidebar user card registers its element as the fly-home target. */
  registerMenuAnchor: (el: HTMLElement | null) => void;
  /** The ribbon reads the menu anchor to compute the dismiss animation target. */
  getMenuAnchor: () => HTMLElement | null;
}

const noop = () => {};

const WhatsNewContext = createContext<WhatsNewContextValue>({
  available: false,
  setAvailable: noop,
  openPopup: noop,
  registerOpener: noop,
  registerMenuAnchor: noop,
  getMenuAnchor: () => null,
});

export function WhatsNewProvider({ children }: { children: ReactNode }) {
  const [available, setAvailable] = useState(false);
  const openerRef = useRef<(() => void) | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);

  const openPopup = useCallback(() => openerRef.current?.(), []);
  const registerOpener = useCallback((fn: (() => void) | null) => {
    openerRef.current = fn;
  }, []);
  const registerMenuAnchor = useCallback((el: HTMLElement | null) => {
    anchorRef.current = el;
  }, []);
  const getMenuAnchor = useCallback(() => anchorRef.current, []);

  const value = useMemo<WhatsNewContextValue>(
    () => ({ available, setAvailable, openPopup, registerOpener, registerMenuAnchor, getMenuAnchor }),
    [available, openPopup, registerOpener, registerMenuAnchor, getMenuAnchor],
  );

  return <WhatsNewContext.Provider value={value}>{children}</WhatsNewContext.Provider>;
}

export function useWhatsNew(): WhatsNewContextValue {
  return useContext(WhatsNewContext);
}
