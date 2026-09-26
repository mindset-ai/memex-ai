import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { AVATAR_COLORS } from '@memex/shared';
import { Avatar } from './Avatar';

// spec-574 — the one person avatar. These mount the component, because the claims are
// about what a viewer sees [per std-45].
const SPEC = 'mindset-prod/memex-building-itself/specs/spec-574';
const AC_ONE_RULE = `${SPEC}/acs/ac-6`;
const AC_ONE_COMPONENT = `${SPEC}/acs/ac-11`;
const AC_COLOR_SCOPE = `${SPEC}/acs/ac-13`;
const AC_COLOR = `${SPEC}/acs/ac-14`;

function avatar() {
  return screen.getByTestId('avatar');
}

describe('Avatar', () => {
  it('shows nominated letters over the derived ones', () => {
    tagAc(AC_ONE_RULE);
    tagAc(AC_ONE_COMPONENT);
    render(<Avatar person={{ name: 'Will Smith', avatarLabel: 'WV' }} />);
    expect(avatar().textContent).toBe('WV');
  });

  it('derives letters from the name, then the email, when nothing is nominated', () => {
    tagAc(AC_ONE_RULE);
    const { rerender } = render(<Avatar person={{ name: 'Barrie Hadfield' }} />);
    expect(avatar().textContent).toBe('BH');
    rerender(<Avatar person={{ name: null, email: 'first.last@example.com' }} />);
    expect(avatar().textContent).toBe('FL');
  });

  it('renders the neutral default when no colour is chosen, exactly as before', () => {
    tagAc(AC_COLOR_SCOPE);
    render(<Avatar person={{ name: 'Sam' }} />);
    expect(avatar().getAttribute('data-avatar-color')).toBe('default');
    expect(avatar().getAttribute('style')).toBeNull();
    expect(avatar().className).toContain('bg-btn-secondary');
  });

  it('fills with the chosen palette colour', () => {
    tagAc(AC_COLOR_SCOPE);
    tagAc(AC_COLOR);
    const teal = AVATAR_COLORS.find((c) => c.key === 'teal')!;
    render(<Avatar person={{ name: 'Sam', avatarColor: 'teal' }} />);
    expect(avatar().getAttribute('data-avatar-color')).toBe('teal');
    expect(avatar().style.backgroundColor).toBe(hexToRgb(teal.background));
    expect(avatar().className).not.toContain('bg-btn-secondary');
  });

  // The load-safety property: nothing a payload can carry makes the avatar throw.
  it.each([
    ['a retired colour', { name: 'Sam', avatarColor: 'chartreuse' }],
    ['a stale session with no avatar fields', { name: 'Sam' }],
    ['no name or email at all', {}],
    ['nulls everywhere', { name: null, email: null, avatarLabel: null, avatarColor: null }],
  ])('renders %s without throwing', (_label, person) => {
    tagAc(AC_COLOR);
    render(<Avatar person={person} />);
    expect(avatar().textContent).toMatch(/^(SA|\?)$/);
    expect(avatar().getAttribute('data-avatar-color')).toBe('default');
  });

  it('is labelled with the name, or hidden from assistive tech when decorative', () => {
    tagAc(AC_ONE_COMPONENT);
    const { rerender } = render(<Avatar person={{ name: 'Ada Lovelace' }} />);
    expect(screen.getByRole('img', { name: 'Ada Lovelace' })).toBe(avatar());
    rerender(<Avatar person={{ name: 'Ada Lovelace' }} decorative />);
    expect(avatar().getAttribute('aria-hidden')).toBe('true');
  });
});

function hexToRgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}
