import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';

const AC_LAYOUT = 'mindset-prod/memex-building-itself/specs/spec-141/acs/ac-7';

vi.mock('../components/AuthContext', () => ({
  useAuth: () => ({
    session: {
      currentMemexId: 'm1',
      memberships: [
        {
          memexId: 'm1',
          slug: 'acme',
          memexSlug: 'team',
          name: 'Acme Inc',
          kind: 'team',
          role: 'administrator',
        },
      ],
    },
  }),
}));

// Stub the tab bodies — this test is about the layout container, not the tab
// contents (each makes its own API calls, covered elsewhere).
vi.mock('../components/account/UsersTab', () => ({
  UsersTab: () => <div data-testid="users-tab-body">users</div>,
}));
vi.mock('../components/account/InvitesTab', () => ({
  InvitesTab: () => <div data-testid="invites-tab-body">invites</div>,
}));
vi.mock('../components/account/SettingsTab', () => ({
  SettingsTab: () => <div data-testid="settings-tab-body">settings</div>,
}));

import { OrgConfiguration } from './OrgConfiguration';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/org']}>
      <OrgConfiguration />
    </MemoryRouter>
  );
}

describe('spec-141 ac-7: Org Configuration layout', () => {
  it('wraps title, tab bar, and content in one shared max-width container', () => {
    tagAc(AC_LAYOUT);
    renderPage();
    const container = screen.getByTestId('org-config');
    expect(container.className).toContain('max-w-3xl');
    expect(container.className).toContain('mx-auto');
  });

  it('renders the tab bar and the active tab content inside that same container (aligned)', () => {
    tagAc(AC_LAYOUT);
    renderPage();
    const container = screen.getByTestId('org-config');
    // Tab bar buttons live in the container...
    expect(within(container).getByRole('button', { name: 'Users' })).toBeInTheDocument();
    expect(within(container).getByRole('button', { name: 'Invites' })).toBeInTheDocument();
    expect(within(container).getByRole('button', { name: 'Settings' })).toBeInTheDocument();
    // ...and so does the active tab's content (default = Users).
    expect(within(container).getByTestId('users-tab-body')).toBeInTheDocument();
  });
});
