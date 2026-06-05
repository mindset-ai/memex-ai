import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

type HeaderSlotContextValue = {
  content: ReactNode;
  setContent: (content: ReactNode) => void;
};

const HeaderSlotContext = createContext<HeaderSlotContextValue | null>(null);

export function HeaderSlotProvider({ children }: { children: ReactNode }) {
  const [content, setContent] = useState<ReactNode>(null);
  return (
    <HeaderSlotContext.Provider value={{ content, setContent }}>
      {children}
    </HeaderSlotContext.Provider>
  );
}

export function useHeaderSlotContent(): ReactNode {
  const ctx = useContext(HeaderSlotContext);
  return ctx?.content ?? null;
}

// Pages render their global-header right-side actions by calling this hook with
// a JSX node. Cleared automatically on unmount.
export function useHeaderSlot(content: ReactNode): void {
  const ctx = useContext(HeaderSlotContext);
  useEffect(() => {
    ctx?.setContent(content);
    return () => ctx?.setContent(null);
  }, [ctx, content]);
}
