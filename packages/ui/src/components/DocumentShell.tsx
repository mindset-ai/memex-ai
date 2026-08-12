import { useEffect, useState, type ReactNode } from 'react';
import { useLocation, useMatch } from 'react-router-dom';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { isDesktopShell } from '../desktop/bridge';
import { ChatPanel } from './ChatPanel';
import { ChatCollapseProvider } from './chat/ChatCollapseContext';
import { CollapsedChatStrip } from './chat/CollapsedChatStrip';
// spec-415 (dec-1): the drift panel honours the SAME pixel floor as the rails
// (standards/issues/scaffold) instead of a viewport percentage, so it can't shrink
// below the shared minimum on laptop/tablet widths. react-resizable-panels v4
// accepts a "<n>px" minSize. defaultSize/maxSize stay percentages — shared MINIMUM only.
import { CHAT_MIN_W } from './chat/chatPanelWidth';
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

  // spec-516 dec-10: a Spec page hosted in the DESKTOP shell hides the web agent
  // entirely and gives the Spec the full width.
  //
  // The desktop client gives a Spec its own tab split into two columns — a column
  // reserved for a later coding session on the left, the Spec on the right. This
  // shell already splits a Spec into two columns of its own, so composed inside
  // that tab a Spec rendered THREE columns: reserved placeholder, this agent rail,
  // canvas. Two narrow left rails competing, one of them deliberately empty until
  // spec-322 lands — worse than the full-width page the desktop layout set out to
  // improve on.
  //
  // It is settled HERE rather than in the shell because the page must own what the
  // page draws: the alternative was the desktop injecting CSS to suppress a
  // surface we chose to render, which would be brittle against any change in here
  // and invisible to these tests. Same division of labour as spec-304 dec-19.
  //
  // SPEC PAGES ONLY. Every other document page keeps its agent in the desktop app,
  // and a plain browser is untouched (isDesktopShell() is false there).
  const specPageMatch = useMatch('/:namespace/:memex/specs/:id');
  // `/:ns/:mx/specs/:id` also matches the literal `specs/tags` manage-tags surface
  // (spec-418 t-5), which is not a Spec — exclude it, exactly as AppShell does.
  const onSpecPage = !!specPageMatch && specPageMatch.params.id !== 'tags';
  // Spec sub-pages (`specs/:id/tasks/t-1`, `…/decisions/dec-2`, …) count too: the
  // desktop's own matcher treats them as "a Spec is open" and renders two columns,
  // so if we kept the rail here a sub-page would be three columns again.
  const onSpecChildPage = !!useMatch('/:namespace/:memex/specs/:id/:childType/:childId');
  const hideAgentForDesktop = isDesktopShell() && (onSpecPage || onSpecChildPage);

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

  // Desktop-hosted Spec (spec-516 dec-10): no agent at all — not the panel, and
  // not the collapsed strip either. The strip would be a second narrow rail beside
  // the desktop's reserved column, which is the very thing this avoids, so the
  // whole rail is gone rather than merely narrowed. Checked BEFORE `collapsed` so a
  // stored collapse preference cannot resurrect it as a strip.
  if (hideAgentForDesktop) {
    return <main className="flex-1 h-full overflow-y-auto">{children}</main>;
  }

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
      <Panel id="chat" defaultSize="24%" minSize={`${CHAT_MIN_W}px`} maxSize="45%">
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
