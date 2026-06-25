// spec-389: collapsing the agent panel. The COLLAPSE STATE lives in whichever
// shell docks the agent (ResizableChatRail for scaffold/standards/issues,
// DocumentShell for spec/drift) — but the collapse AFFORDANCE belongs in the
// shared ChatPanel header so every agent gets the identical control. This tiny
// context bridges the two without prop-drilling through the generic rail's
// `children`. A shell that supports collapsing provides `onCollapse`; ChatPanel
// reads it and renders the header button only when present (so panels that can't
// collapse — none today, but the default — simply don't show it).

import { createContext, useContext, type ReactNode } from 'react';

interface ChatCollapseValue {
  /** Collapse the agent panel to its closed strip. Undefined → not collapsible. */
  onCollapse?: () => void;
}

const ChatCollapseContext = createContext<ChatCollapseValue>({});

export function ChatCollapseProvider({
  onCollapse,
  children,
}: {
  onCollapse?: () => void;
  children: ReactNode;
}) {
  return (
    <ChatCollapseContext.Provider value={{ onCollapse }}>
      {children}
    </ChatCollapseContext.Provider>
  );
}

export function useChatCollapse(): ChatCollapseValue {
  return useContext(ChatCollapseContext);
}
