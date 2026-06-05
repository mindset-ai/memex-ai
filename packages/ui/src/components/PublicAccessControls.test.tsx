import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PublicAuthButtons, ReadOnlyBadge } from './PublicAccessControls';
import { buildSignupUrl, readReturnTo } from '../utils/publicSignup';
import { tagAc } from "@memex-ai-ac/vitest";

const AC_SIGNUP_BUTTON =
  'mindset-prod/memex-building-itself/specs/spec-111/acs/ac-7';

describe('PublicAuthButtons (spec-111 t-8, ac-7)', () => {
  it('renders Log in + Sign up, both starting the auth flow with a returnTo', () => {
    tagAc(AC_SIGNUP_BUTTON);
    render(<PublicAuthButtons returnTo="/acme/open-roadmap/specs" />);

    const signup = screen.getByTestId('public-signup-button');
    const login = screen.getByTestId('public-login-button');
    expect(signup).toHaveTextContent('Sign up');
    expect(login).toHaveTextContent('Log in');

    // Both point at the identifier-first /login page with the returnTo intact.
    for (const link of [signup, login]) {
      const href = link.getAttribute('href') ?? '';
      expect(href.startsWith('/login?returnTo=')).toBe(true);
      expect(readReturnTo(new URL(href, 'http://x').search)).toBe(
        '/acme/open-roadmap/specs',
      );
    }
  });

  it('buildSignupUrl encodes the path so query/hash survive the bounce', () => {
    tagAc(AC_SIGNUP_BUTTON);
    const url = buildSignupUrl('/ns/mx/specs/spec-1?tab=decisions');
    expect(readReturnTo(new URL(url, 'http://x').search)).toBe(
      '/ns/mx/specs/spec-1?tab=decisions',
    );
  });

  it('ReadOnlyBadge renders the 🌐 read-only indicator', () => {
    tagAc(AC_SIGNUP_BUTTON);
    render(<ReadOnlyBadge />);
    const badge = screen.getByTestId('readonly-sidebar-badge');
    expect(badge).toHaveTextContent(/Read-only/i);
    expect(badge.textContent).toContain('🌐');
  });
});
