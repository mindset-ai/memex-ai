// spec-389: the agent panel's collapsed ("closed") state is PER-AGENT, not shared.
// DocumentShell hosts two distinct agents — the doc/spec assistant and the drift
// agent — so collapsing one must not collapse the other. The preference is keyed
// by the active agent (`memex:doc-chat-collapsed:{drift|spec}`); these tests pin
// that a stored state for one agent never leaks into the other.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';

const AC_VISUAL = 'mindset-prod/memex-building-itself/specs/spec-389/acs/ac-1';

let mockIsDriftMode = false;
vi.mock('./ChatContext', () => ({
  useChat: () => ({ isDriftMode: mockIsDriftMode }),
}));
vi.mock('./AuthContext', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('../hooks/useMemexAccess', () => ({
  useMemexAccess: () => ({ canWrite: true }),
}));
vi.mock('./ChatPanel', () => ({
  ChatPanel: () => <div data-testid="chat-panel" />,
}));
// react-resizable-panels measures layout — render its parts as plain wrappers so
// the expanded branch mounts cleanly in jsdom.
vi.mock('react-resizable-panels', () => ({
  Group: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Panel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Separator: () => <div data-testid="resize-handle" />,
}));

import { DocumentShell } from './DocumentShell';

const DRIFT_KEY = 'memex:doc-chat-collapsed:drift';
const SPEC_KEY = 'memex:doc-chat-collapsed:spec';

function renderShell() {
  return render(
    <MemoryRouter>
      <DocumentShell>
        <div data-testid="content">page</div>
      </DocumentShell>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  mockIsDriftMode = false;
});

describe('DocumentShell — per-agent collapsed state (spec-389)', () => {
  it('the drift agent reads its OWN key — a collapsed spec assistant does not collapse it', () => {
    tagAc(AC_VISUAL);
    window.localStorage.setItem(SPEC_KEY, '1'); // spec assistant is collapsed…
    mockIsDriftMode = true; // …but we're on the drift agent
    renderShell();
    // Drift is NOT collapsed (its own key is unset): the panel is open.
    expect(screen.queryByTestId('doc-chat-collapsed')).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-panel')).toBeInTheDocument();
  });

  it('the drift agent collapses when ITS key is set, labelled "Drift"', () => {
    tagAc(AC_VISUAL);
    window.localStorage.setItem(DRIFT_KEY, '1');
    mockIsDriftMode = true;
    renderShell();
    expect(screen.getByTestId('doc-chat-collapsed')).toHaveAccessibleName(/Drift/);
    expect(screen.queryByTestId('chat-panel')).not.toBeInTheDocument();
  });

  it('the spec assistant reads its own key — a collapsed drift agent does not collapse it', () => {
    tagAc(AC_VISUAL);
    window.localStorage.setItem(DRIFT_KEY, '1'); // drift is collapsed…
    mockIsDriftMode = false; // …but we're on the doc/spec assistant
    renderShell();
    expect(screen.queryByTestId('doc-chat-collapsed')).not.toBeInTheDocument();
    expect(screen.getByTestId('chat-panel')).toBeInTheDocument();
  });

  it('the spec assistant collapses when ITS key is set, labelled "Assistant"', () => {
    tagAc(AC_VISUAL);
    window.localStorage.setItem(SPEC_KEY, '1');
    mockIsDriftMode = false;
    renderShell();
    expect(screen.getByTestId('doc-chat-collapsed')).toHaveAccessibleName(/Assistant/);
  });
});
