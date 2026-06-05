import { type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { ChatPanel } from './ChatPanel';
import { useAuth } from './AuthContext';
import { useMemexAccess } from '../hooks/useMemexAccess';

function ResizeHandle() {
  return (
    <Separator className="w-px transition-all cursor-col-resize hover:w-1 bg-edge hover:bg-edge-strong active:bg-edge-strong" />
  );
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

  return (
    // Group id is versioned: react-resizable-panels persists the layout per
    // Group id, so default-size changes only reach users on a fresh id —
    // v10 ships the slimmer 24% chat default (was 32%).
    <Group id="memex-shell-v10" orientation="horizontal" className="h-full">
      <Panel id="chat" defaultSize="24%" minSize="16%" maxSize="45%">
        <aside className="h-full relative">
          <div className="absolute inset-0">
            <ChatPanel isAuthenticated={isAuthenticated} readOnly={readOnly} />
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
