// spec-516 dec-10: a Spec page hosted in the DESKTOP shell hides the web agent.
//
// The desktop client (spec-516) gives a Spec its own tab split into two columns —
// a reserved column held for a later coding session on the left, the Spec on the
// right. But DocumentShell already lays a Spec out as two columns of its OWN (the
// ChatPanel rail at 24%, then the canvas), so composed inside that tab a Spec
// rendered THREE columns: reserved placeholder, agent rail, canvas. Two narrow
// left rails competing, one of them deliberately empty for months.
//
// dec-10 settles it here rather than in the shell: React already knows when it is
// hosted in the desktop (isDesktopShell(), spec-304 dec-19), so the page decides
// what it draws and the shell keeps owning only the frame. The desktop never
// reaches into the DOM.
//
// Scope is deliberately narrow — Spec pages only. In the desktop app every other
// DocumentShell page keeps its agent, and a plain browser is untouched.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';

const AC_HIDES = 'mindset-prod/memex-building-itself/specs/spec-516/acs/ac-21';

let mockIsDesktopShell = false;
vi.mock('../desktop/bridge', () => ({
  isDesktopShell: () => mockIsDesktopShell,
}));

vi.mock('./ChatContext', () => ({ useChat: () => ({ isDriftMode: false }) }));
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

const SPEC_PAGE = '/mindset-prod/memex-building-itself/specs/spec-516';
const SPEC_SUBPAGE = `${SPEC_PAGE}/tasks/t-1`;
const SPEC_TAGS = '/mindset-prod/memex-building-itself/specs/tags';
const STANDARD_PAGE = '/mindset-prod/memex-building-itself/standards/std-25';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <DocumentShell>
        <div data-testid="content">page</div>
      </DocumentShell>
    </MemoryRouter>,
  );
}

/** The agent is gone entirely — panel, collapsed strip and the resize seam. */
function expectNoAgent() {
  expect(screen.queryByTestId('chat-panel')).not.toBeInTheDocument();
  expect(screen.queryByTestId('doc-chat-collapsed')).not.toBeInTheDocument();
  expect(screen.queryByTestId('resize-handle')).not.toBeInTheDocument();
  // …and the Spec itself still renders, at full width.
  expect(screen.getByTestId('content')).toBeInTheDocument();
}

function expectAgent() {
  expect(screen.getByTestId('chat-panel')).toBeInTheDocument();
  expect(screen.getByTestId('content')).toBeInTheDocument();
}

beforeEach(() => {
  window.localStorage.clear();
  mockIsDesktopShell = false;
});

describe('DocumentShell — hide the web agent on a desktop-hosted Spec (spec-516 dec-10)', () => {
  it('desktop shell + Spec page → no agent panel, no collapsed strip, no seam', () => {
    tagAc(AC_HIDES);
    mockIsDesktopShell = true;
    renderAt(SPEC_PAGE);
    expectNoAgent();
  });

  it('desktop shell + Spec SUB-page → also no agent', () => {
    tagAc(AC_HIDES);
    // The desktop renders two columns for Spec sub-pages too (its isSpecUrl
    // matcher counts `…/specs/spec-N/tasks/t-1` as "a Spec is open"), so the two
    // sides must agree — otherwise a sub-page is three columns again.
    mockIsDesktopShell = true;
    renderAt(SPEC_SUBPAGE);
    expectNoAgent();
  });

  it('desktop shell + a NON-Spec document page → the agent still renders', () => {
    tagAc(AC_HIDES);
    mockIsDesktopShell = true;
    renderAt(STANDARD_PAGE);
    expectAgent();
  });

  it('desktop shell + the specs/tags surface → the agent still renders', () => {
    tagAc(AC_HIDES);
    // `/:ns/:mx/specs/:id` also matches the literal `specs/tags` manage-tags
    // surface (spec-418 t-5). That is not a Spec, so it keeps its agent.
    mockIsDesktopShell = true;
    renderAt(SPEC_TAGS);
    expectAgent();
  });

  it('plain browser + Spec page → the agent renders exactly as before', () => {
    tagAc(AC_HIDES);
    mockIsDesktopShell = false;
    renderAt(SPEC_PAGE);
    expectAgent();
  });

  it('the desktop rule does not depend on the collapse preference either way', () => {
    tagAc(AC_HIDES);
    // A previously-collapsed agent must not resurrect as the collapsed STRIP in
    // the desktop — the whole rail is gone, not merely narrowed.
    window.localStorage.setItem('memex:doc-chat-collapsed:spec', '1');
    mockIsDesktopShell = true;
    renderAt(SPEC_PAGE);
    expectNoAgent();
  });
});
