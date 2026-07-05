import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';
import { ThemeProvider } from './ThemeContext';

// spec-460 ac-18: the account menu carries always-present "Download desktop app"
// and "Book a call" fallbacks so dismissing the Getting Started card never loses
// either action.
const AC_MENU_FALLBACKS = 'mindset-prod/memex-building-itself/specs/spec-460/acs/ac-18';

const { logoutSpy } = vi.hoisted(() => ({ logoutSpy: vi.fn() }));

const TEAM_ADMIN = {
  memexId: 'm1',
  slug: 'acme',
  memexSlug: 'team',
  name: 'Acme Inc',
  memexName: 'Team',
  kind: 'team' as const,
  role: 'administrator' as const,
};

const session = {
  user: { id: 'u1', name: 'Tester', email: 't@acme.test' },
  memberships: [TEAM_ADMIN],
  currentMemexId: 'm1',
};

vi.mock('./AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u1', name: 'Tester', email: 't@acme.test' },
    session,
    logout: logoutSpy,
  }),
}));

vi.mock('./whats-new/WhatsNewContext', () => ({
  useWhatsNew: () => ({
    available: true,
    hasUnseen: false,
    openPopup: vi.fn(),
    registerMenuAnchor: vi.fn(),
  }),
}));

vi.mock('./MemexSwitcher', () => ({ MemexSwitcher: () => <div data-testid="memex-switcher" /> }));
vi.mock('./InviteMembersDialog', () => ({ InviteMembersDialog: () => <div data-testid="invite-dialog" /> }));
vi.mock('../hooks/useMemexAccess', () => ({
  useMemexAccess: () => ({ isAuthenticated: true, isVisitedReadOnly: false }),
}));
vi.mock('../hooks/useDriftInboxCount', () => ({ useDriftInboxCount: () => 0 }));

// Keep the Getting Started card out of the way for this menu test: seed it as
// connected (app row retired) so it doesn't fire a real journey fetch.
vi.mock('../journeys/journeyStateCache', () => ({
  getCachedJourneyState: () => ({ milestones: { mcpConnected: true } }),
}));
vi.mock('../api/journey', () => ({
  fetchJourneyStateApi: () => Promise.resolve({ milestones: { mcpConnected: true } }),
}));
vi.mock('../hooks/useTelemetry', () => ({
  useTelemetry: () => ({ track: vi.fn(), optedOut: false, setOptOut: vi.fn() }),
}));

import { AppShell } from './AppShell';

function openMenu() {
  render(
    <ThemeProvider>
      <MemoryRouter initialEntries={['/acme/team/specs']}>
        <AppShell>
          <div data-testid="page-content">page</div>
        </AppShell>
      </MemoryRouter>
    </ThemeProvider>,
  );
  fireEvent.click(screen.getByText('Tester'));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('spec-460: account-menu fallback rows (ac-18)', () => {
  it('shows Download desktop app + Book a call, pointing at the marketing pages with ?src=account-menu', () => {
    tagAc(AC_MENU_FALLBACKS);
    openMenu();

    const download = screen.getByTestId('user-menu-download-app');
    const book = screen.getByTestId('user-menu-book-a-call');

    expect(download).toHaveTextContent('Download desktop app');
    expect(download).toHaveAttribute('href', 'https://www.memex.ai/download?src=account-menu');
    expect(download).toHaveAttribute('target', '_blank');
    expect(download).toHaveAttribute('rel', 'noopener noreferrer');

    expect(book).toHaveTextContent('Book a call');
    expect(book).toHaveAttribute('href', 'https://www.memex.ai/book-a-call?src=account-menu');
    expect(book).toHaveAttribute('target', '_blank');
    expect(book).toHaveAttribute('rel', 'noopener noreferrer');

    // Each row carries an icon, matching the spec-456 menu convention.
    expect(download.querySelector('svg')).not.toBeNull();
    expect(book.querySelector('svg')).not.toBeNull();
  });

  it('keeps the rows present regardless of Getting Started card state (always-on fallback)', () => {
    tagAc(AC_MENU_FALLBACKS);
    // Card is retired (mcpConnected) in this harness; the menu rows must still exist.
    openMenu();
    expect(screen.getByTestId('user-menu-download-app')).toBeInTheDocument();
    expect(screen.getByTestId('user-menu-book-a-call')).toBeInTheDocument();
  });
});
