import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

// Two contexts, deliberately split (spec-260 build finding):
//
// The original single-context shape ({ content, setContent } minted fresh each
// provider render) made every useHeaderSlot PAGE a subscriber of the content it
// was itself setting. Pages pass inline JSX — a new element identity every
// render — so the effect re-fired each render: setContent → provider re-render
// → page re-render (consumer) → new element → setContent → … an UNBOUNDED
// passive-effect render loop on every page using the slot. Cheap renders kept
// it invisible in the app; a heavier child (the spec-260 QA Report card) made
// vitest runs exhaust the heap, which is how it surfaced.
//
// The fix is the standard split: pages depend only on the stable SETTER context
// (so writing content never re-renders them), while the header sink alone
// subscribes to the CONTENT context. A page render still pushes fresh content
// (new JSX identity → effect refires), but that now re-renders only the header
// sink — bounded by page renders instead of feeding back into them.

const HeaderSlotContentContext = createContext<ReactNode>(null);
const HeaderSlotSetterContext = createContext<((content: ReactNode) => void) | null>(null);

export function HeaderSlotProvider({ children }: { children: ReactNode }) {
  const [content, setContent] = useState<ReactNode>(null);
  return (
    // setContent from useState is referentially stable, so the setter context
    // value never changes — pages subscribed to it never re-render from here.
    <HeaderSlotSetterContext.Provider value={setContent}>
      <HeaderSlotContentContext.Provider value={content}>
        {children}
      </HeaderSlotContentContext.Provider>
    </HeaderSlotSetterContext.Provider>
  );
}

export function useHeaderSlotContent(): ReactNode {
  return useContext(HeaderSlotContentContext);
}

// Pages render their global-header right-side actions by calling this hook with
// a JSX node. Cleared automatically on unmount.
export function useHeaderSlot(content: ReactNode): void {
  const setContent = useContext(HeaderSlotSetterContext);
  useEffect(() => {
    setContent?.(content);
    return () => setContent?.(null);
  }, [setContent, content]);
}
