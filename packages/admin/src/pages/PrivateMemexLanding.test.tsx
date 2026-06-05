import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PrivateMemexLanding } from './PrivateMemexLanding';
import { readReturnTo } from '../utils/publicSignup';
import { tagAc } from "@memex-ai-ac/vitest";

const AC_PRIVATE_LANDING =
  'mindset-prod/memex-building-itself/specs/spec-111/acs/ac-5';

describe('PrivateMemexLanding (spec-111 t-8, ac-5)', () => {
  it('shows the "This Memex is private" message with a Sign in CTA', () => {
    tagAc(AC_PRIVATE_LANDING);
    render(<PrivateMemexLanding returnTo="/secret-org/internal/specs" />);

    expect(screen.getByTestId('private-memex-landing')).toBeInTheDocument();
    expect(screen.getByText(/This Memex is private/i)).toBeInTheDocument();

    const cta = screen.getByTestId('private-memex-signin');
    expect(cta).toHaveTextContent(/Sign in/i);
    // The CTA carries a returnTo so the member lands back here after signing in.
    const href = cta.getAttribute('href') ?? '';
    expect(href.startsWith('/login?returnTo=')).toBe(true);
    expect(readReturnTo(new URL(href, 'http://x').search)).toBe(
      '/secret-org/internal/specs',
    );
  });

  it('offers NO request-access flow (sign in is the only forward action)', () => {
    tagAc(AC_PRIVATE_LANDING);
    render(<PrivateMemexLanding returnTo="/x/y/specs" />);
    expect(screen.queryByText(/request access/i)).not.toBeInTheDocument();
  });
});
