import { useEffect, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { ChatPanel } from './ChatPanel';
import { ChatCollapseProvider } from './chat/ChatCollapseContext';
import { CollapsedChatStrip } from './chat/CollapsedChatStrip';
import { useChat } from './ChatContext';
import { useAuth } from './AuthContext';
import { useMemexAccess } from '../hooks/useMemexAccess';

function ResizeHandle() {
  return (
    <Separator className="w-px transition-all cursor-col-resize hover:w-1 bg-edge hover:bg-edge-strong active:bg-edge-strong" />
  );
}

// spec-389: collapse the agent panel to its strip — same affordance as the docked
// scaffold/standards/issues rails. The closed state is PER-AGENT, not shared: this
// shell hosts two distinct agents (the doc/spec assistant and the drift agent), so
// the preference is keyed by which one is active. Persisted in localStorage.
const COLLAPSE_KEY_BASE = 'memex:doc-chat-collapsed';
function readCollapsed(key: string): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(key) === '1';
}

export function DocumentShell({ children }: { children: ReactNode }) {
  // spec-111 t-9 — feed ChatPanel the three public-access states (dec-2):
  //   - anonymous (no session) → "Sign in to chat" placeholder.
  //   - signed-in non-member on a public Memex → read-only agent.
  //   - org member → full agent (the defaults). canWrite is per-Memex, so
  //     readOnly only fires for a signed-in caller who can't write here.
  const { isAuthenticated } = useAuth();
  const location = useLocation();
  const access = useMemexAccess(location.pathname);
  const readOnly = isAuthenticated && !access.canWrite;

  // The active agent identity. This shell only ever hosts the drift agent or the
  // doc/spec assistant, so isDriftMode is the distinguishing bit. The drift route
  // flips this on after mount (OpeningDriftController), hence the re-sync below.
  const { isDriftMode } = useChat();
  const agent = isDriftMode ? 'drift' : 'spec';
  const collapseKey = `${COLLAPSE_KEY_BASE}:${agent}`;
  const label = isDriftMode ? 'Drift' : 'Assistant';

  const [collapsed, setCollapsed] = useState<boolean>(() => readCollapsed(collapseKey));

  // Adopt the active agent's saved state whenever the agent identity changes.
  // This only READS — persistence happens in the toggle handler — so switching
  // agents can never clobber the other agent's stored preference.
  useEffect(() => {
    setCollapsed(readCollapsed(collapseKey));
  }, [collapseKey]);

  const setCollapsedPersist = (next: boolean) => {
    setCollapsed(next);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(collapseKey, next ? '1' : '0');
    }
  };

  // Collapsed: the agent shrinks to its strip and the canvas takes the full
  // width — no resizable group while closed.
  if (collapsed) {
    return (
      <div className="flex h-full">
        <CollapsedChatStrip
          onExpand={() => setCollapsedPersist(false)}
          label={label}
          testId="doc-chat-collapsed"
        />
        <main className="flex-1 h-full overflow-y-auto">{children}</main>
      </div>
    );
  }

  return (
    // Group id is versioned: react-resizable-panels persists the layout per
    // Group id, so default-size changes only reach users on a fresh id —
    // v10 ships the slimmer 24% chat default (was 32%).
    <Group id="memex-shell-v10" orientation="horizontal" className="h-full">
      <Panel id="chat" defaultSize="24%" minSize="16%" maxSize="45%">
        <aside className="h-full relative">
          <div className="absolute inset-0">
            <ChatCollapseProvider onCollapse={() => setCollapsedPersist(true)}>
              <ChatPanel isAuthenticated={isAuthenticated} readOnly={readOnly} />
            </ChatCollapseProvider>
          </div>
        </aside>
      </Panel>

      <ResizeHandle />

      <Panel id="canvas" defaultSize="76%" minSize="55%" maxSize="84%">
        <main className="h-full overflow-y-auto">
          {children}
        </main>
      </Panel>
    </Group>
  );
}
