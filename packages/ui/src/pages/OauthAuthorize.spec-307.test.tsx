import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { tagAc } from '@memex-ai-ac/vitest';

// spec-307 ac-9: the OAuth consent screen grants the user's FULL live membership.
// There is no Org picker, the copy states all-Memexes access, and the decision is
// submitted with no per-grant Org scope (no org_id arg). Supersedes b-31 dec-8.

const AC_9 = 'mindset-prod/memex-building-itself/specs/spec-307/acs/ac-9';

const decisionSpy = vi.fn(async () => ({ redirect: 'https://app.example/cb?code=abc' }));
const previewSpy = vi.fn(async () => ({ client_name: 'Claude', scopes: ['memex.full'] }));

vi.mock('../api/client', () => ({
  oauthAuthorizePreviewApi: (...args: unknown[]) => previewSpy(...(args as [])),
  oauthAuthorizeDecisionApi: (...args: unknown[]) => decisionSpy(...(args as [])),
}));

vi.mock('../components/AuthContext', async () => {
  const real = await vi.importActual<typeof import('../components/AuthContext')>(
    '../components/AuthContext',
  );
  return {
    ...real,
    useAuth: () => ({
      token: 'tok-1',
      isAuthenticated: true,
      session: null,
      user: null,
      authError: null,
      logout: vi.fn(),
      updateSession: vi.fn(),
      acceptSession: vi.fn(),
    }),
  };
});

import { OauthAuthorize } from './OauthAuthorize';

const OAUTH_QS =
  '?response_type=code&client_id=c-1&redirect_uri=https://app.example/cb' +
  '&code_challenge=chal&code_challenge_method=S256&state=st';

function renderConsent() {
  return render(
    <MemoryRouter initialEntries={[`/oauth/authorize${OAUTH_QS}`]}>
      <Routes>
        <Route path="/oauth/authorize" element={<OauthAuthorize />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('spec-307: OAuth consent screen grants full live membership (ac-9)', () => {
  let originalLocation: Location;
  beforeEach(() => {
    decisionSpy.mockClear();
    previewSpy.mockClear();
    originalLocation = window.location;
    // jsdom throws "Not implemented: navigation" on href assignment; stub it.
    Object.defineProperty(window, 'location', { value: { href: '' }, writable: true });
  });
  afterEach(() => {
    Object.defineProperty(window, 'location', { value: originalLocation, writable: true });
  });

  it('renders no Org picker and states all-Memexes access', async () => {
    tagAc(AC_9);
    renderConsent();
    await screen.findByText('Claude');
    // No Org picker (the superseded b-31 dec-8 UI).
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByText(/Choose the Org/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/only grant one Org/i)).not.toBeInTheDocument();
    // Honest copy: the grant is all your Memexes.
    expect(screen.getByText(/all your Memexes/i)).toBeInTheDocument();
    expect(screen.getByText(/every Org you're a member of/i)).toBeInTheDocument();
  });

  it('Allow submits the decision with no per-grant Org scope (no org_id arg)', async () => {
    tagAc(AC_9);
    renderConsent();
    const allow = await screen.findByRole('button', { name: /allow/i });
    fireEvent.click(allow);
    await waitFor(() => expect(decisionSpy).toHaveBeenCalledTimes(1));
    const callArgs = decisionSpy.mock.calls[0];
    // (params, decision, token) — exactly three args, NO fourth orgId.
    expect(callArgs).toHaveLength(3);
    expect(callArgs[1]).toBe('allow');
    expect(callArgs[2]).toBe('tok-1');
  });
});
