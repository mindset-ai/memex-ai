// spec-415 (dec-1, ac-5): the drift chat Panel in DocumentShell must set `minSize`
// to the shared PIXEL floor (CHAT_MIN_W → "300px"), not a viewport percentage, so
// the drift agent can no longer shrink below the rail floor on small viewports.
// We render DocumentShell with react-resizable-panels' Panel mocked to surface its
// minSize prop, then assert the chat panel carries the px floor (not "16%").

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { CHAT_MIN_W } from './chat/chatPanelWidth';

const AC5 = 'mindset-prod/memex-building-itself/specs/spec-415/acs/ac-5';

vi.mock('./ChatContext', () => ({ useChat: () => ({ isDriftMode: true }) }));
vi.mock('./AuthContext', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../hooks/useMemexAccess', () => ({
  useMemexAccess: () => ({ canWrite: true }),
}));
vi.mock('./ChatPanel', () => ({
  ChatPanel: () => <div data-testid="chat-panel" />,
}));
// Surface each Panel's id + minSize so the test can read the rendered props.
vi.mock('react-resizable-panels', () => ({
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Panel: ({
    id,
    minSize,
    children,
  }: {
    id?: string;
    minSize?: string;
    children: React.ReactNode;
  }) => (
    <div data-testid={`panel-${id}`} data-min-size={String(minSize)}>
      {children}
    </div>
  ),
  Separator: () => <div data-testid="resize-handle" />,
}));

import { DocumentShell } from './DocumentShell';

beforeEach(() => {
  window.localStorage.clear();
});

function renderShell() {
  return render(
    <MemoryRouter>
      <DocumentShell>
        <div data-testid="content">page</div>
      </DocumentShell>
    </MemoryRouter>,
  );
}

describe('DocumentShell — drift panel shares the rail px floor (spec-415)', () => {
  it('ac-5: the drift chat Panel minSize is the shared px floor, not a percentage', () => {
    tagAc(AC5);
    renderShell();
    const chatPanel = screen.getByTestId('panel-chat');
    const minSize = chatPanel.getAttribute('data-min-size');
    // The px floor (e.g. "300px") — a true pixel minimum independent of viewport.
    expect(minSize).toBe(`${CHAT_MIN_W}px`);
    expect(minSize).toMatch(/px$/);
    // Specifically NOT the old viewport-percentage floor.
    expect(minSize).not.toMatch(/%$/);
  });
});
