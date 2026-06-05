import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { MembershipSummary } from '../api/client';
import { tagAc } from "@memex-ai-ac/vitest";

const AC_SIGNUP_AUTOADD =
  'mindset-prod/memex-building-itself/specs/spec-111/acs/ac-8';

// getCurrentTenant reads window.location; pin it so the switcher renders
// deterministically regardless of the jsdom URL.
vi.mock('../utils/tenantUrl', async () => {
  const actual = await vi.importActual<typeof import('../utils/tenantUrl')>(
    '../utils/tenantUrl',
  );
  return {
    ...actual,
    getCurrentTenant: () => ({ namespace: 'acme', memex: 'main' }),
  };
});

const useAuthMock = vi.fn();
vi.mock('./AuthContext', () => ({ useAuth: () => useAuthMock() }));

import { MemexSwitcher } from './MemexSwitcher';

function orgRow(over: Partial<MembershipSummary> = {}): MembershipSummary {
  return {
    memexId: 'mx-org',
    slug: 'acme',
    memexSlug: 'main',
    name: 'Acme',
    memexName: 'Main',
    kind: 'team',
    role: 'member',
    source: 'org',
    accessLevel: 'write',
    ...over,
  };
}

function personalRow(): MembershipSummary {
  return {
    memexId: 'mx-personal',
    slug: 'alice',
    memexSlug: 'personal',
    name: 'Personal Memex',
    memexName: 'Personal Memex',
    kind: 'personal',
    role: 'administrator',
    source: 'org',
    accessLevel: 'write',
  };
}

function visitedRow(): MembershipSummary {
  return {
    memexId: 'mx-visited',
    slug: 'open-org',
    memexSlug: 'public-roadmap',
    name: 'Public Roadmap',
    memexName: 'Public Roadmap',
    kind: 'team',
    role: 'member',
    source: 'visited',
    accessLevel: 'read',
  };
}

function setSession(memberships: MembershipSummary[]) {
  useAuthMock.mockReturnValue({
    session: {
      user: { id: 'u-1', email: 'alice@example.com' },
      memberships,
    },
  });
}

beforeEach(() => {
  useAuthMock.mockReset();
});

describe('MemexSwitcher — Your Memexes + Visited (spec-111 t-8)', () => {
  it('renders a Visited group for read-only public memexes (post-signup auto-add)', async () => {
    tagAc(AC_SIGNUP_AUTOADD);
    // The shape a non-member sees AFTER completing signup: a freshly-created
    // personal memex PLUS the public memex they signed up from, auto-added to
    // user_memex_access (server side, t-6) and surfaced as a `visited` row.
    setSession([personalRow(), visitedRow()]);

    render(
      <MemoryRouter>
        <MemexSwitcher />
      </MemoryRouter>,
    );

    await userEvent.click(screen.getByTitle('Switch Memex'));

    // "Your" personal memex is present (created during signup).
    expect(screen.getByText('Your personal Memex')).toBeInTheDocument();
    // The Visited group surfaces the auto-added public memex, read-only.
    expect(screen.getByTestId('visited-memexes-header')).toHaveTextContent(/Visited/);
    expect(screen.getByText('Public Roadmap')).toBeInTheDocument();
    expect(screen.getByText('Read-only')).toBeInTheDocument();
  });

  it('keeps visited public memexes OUT of the "Your orgs" group', async () => {
    tagAc(AC_SIGNUP_AUTOADD);
    setSession([personalRow(), orgRow(), visitedRow()]);

    render(
      <MemoryRouter>
        <MemexSwitcher />
      </MemoryRouter>,
    );

    await userEvent.click(screen.getByTitle('Switch Memex'));

    // Org section renders the real org row; the visited row is segregated under
    // Visited, not duplicated as an org membership.
    expect(screen.getByText('Your orgs')).toBeInTheDocument();
    expect(screen.getByTestId('visited-memexes-header')).toBeInTheDocument();
    expect(screen.getByText('Public Roadmap')).toBeInTheDocument();
  });

  it('renders no Visited group when the user has no visited memexes', async () => {
    tagAc(AC_SIGNUP_AUTOADD);
    setSession([personalRow(), orgRow()]);

    render(
      <MemoryRouter>
        <MemexSwitcher />
      </MemoryRouter>,
    );

    await userEvent.click(screen.getByTitle('Switch Memex'));
    expect(screen.queryByTestId('visited-memexes-header')).not.toBeInTheDocument();
  });
});
