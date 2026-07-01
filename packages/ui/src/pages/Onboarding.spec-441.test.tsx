import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';

// spec-441 dec-2 / ac-9 — Onboarding.tsx redirects already-named users to /
// so they don't see "Welcome! Let's set up your profile." after a name is set.

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-441/acs/ac-${n}`;

vi.mock('../components/AuthContext', async () => {
  const real = await vi.importActual<typeof import('../components/AuthContext')>(
    '../components/AuthContext',
  );
  return {
    ...real,
    useAuth: () => mockUseAuth(),
  };
});

let mockUseAuth: () => ReturnType<typeof import('../components/AuthContext').useAuth>;

import { Onboarding } from './Onboarding';

function renderOnboarding() {
  return render(
    <MemoryRouter initialEntries={['/onboarding']}>
      <Routes>
        <Route path="/onboarding" element={<Onboarding />} />
        <Route path="/" element={<div data-testid="root-page">root</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('spec-441 dec-2: Onboarding named-user redirect (ac-9)', () => {
  it('ac-9: already-named user is immediately redirected to / — does not see the form', async () => {
    tagAc(AC(9));
    mockUseAuth = () => ({
      session: null,
      user: { name: 'Alice', email: 'alice@example.com', picture: '' },
      token: 'fake-token',
      isAuthenticated: true,
      authError: null,
      logout: vi.fn(),
      updateSession: vi.fn(),
      acceptSession: vi.fn(),
    });
    renderOnboarding();
    expect(await screen.findByTestId('root-page')).toBeInTheDocument();
    expect(screen.queryByText("What's your name?")).not.toBeInTheDocument();
  });

  it('ac-9: nameless user sees the name form — not redirected', async () => {
    tagAc(AC(9));
    mockUseAuth = () => ({
      session: null,
      user: { name: '', email: 'alice@example.com', picture: '' },
      token: 'fake-token',
      isAuthenticated: true,
      authError: null,
      logout: vi.fn(),
      updateSession: vi.fn(),
      acceptSession: vi.fn(),
    });
    renderOnboarding();
    expect(await screen.findByText("What's your name?")).toBeInTheDocument();
    expect(screen.queryByTestId('root-page')).not.toBeInTheDocument();
  });
});
