// spec-305 — the journey's identity step (name confirm + role triangle).
// ac-2 — the user confirms/changes the SSO name; it persists.
// ac-5 — the role persists as barycentric weights summing to 1; Skip persists the
//        centered "generalist" default and the step never blocks progress.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';

const updateProfileApi = vi.hoisted(() => vi.fn());
const updateSession = vi.hoisted(() => vi.fn());

vi.mock('../../api/client', () => ({ updateProfileApi }));
vi.mock('../AuthContext', () => ({
  useAuth: () => ({
    token: 'fake',
    user: { id: 'u-1', name: 'John Doe', email: 'john@example.com' },
    updateSession,
  }),
}));

import { IdentityStep } from './IdentityStep';
import { personaLabel, CENTERED_ROLE } from './RoleTriangle';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-305/acs/ac-${n}`;

function sums1(c: { dev: number; design: number; pm: number }) {
  return Math.abs(c.dev + c.design + c.pm - 1) < 1e-9;
}

beforeEach(() => {
  updateProfileApi.mockReset();
  updateSession.mockReset();
  updateProfileApi.mockResolvedValue({ needsOnboarding: false });
});

describe('IdentityStep', () => {
  it('confirms the SSO name and shows the role triangle + persona label', () => {
    tagAc(AC(2));
    render(<IdentityStep />);
    expect(screen.getByTestId('journey-step-identity')).toBeInTheDocument();
    expect(screen.getByTestId('identity-name')).toHaveValue('John Doe'); // pre-filled from SSO
    expect(screen.getByTestId('role-triangle')).toBeInTheDocument();
    expect(screen.getByTestId('persona-label')).toBeInTheDocument();
  });

  it('Continue persists name + role coords (summing to 1) and refreshes the session', async () => {
    tagAc(AC(2));
    tagAc(AC(5));
    render(<IdentityStep />);
    fireEvent.click(screen.getByTestId('identity-continue'));
    await waitFor(() => expect(updateProfileApi).toHaveBeenCalledTimes(1));
    const [, name, coords] = updateProfileApi.mock.calls[0];
    expect(name).toBe('John Doe');
    expect(sums1(coords)).toBe(true);
    await waitFor(() => expect(updateSession).toHaveBeenCalledWith({ needsOnboarding: false }));
  });

  it('Skip persists the centered default and still submits (never blocks)', async () => {
    tagAc(AC(5));
    render(<IdentityStep />);
    fireEvent.click(screen.getByTestId('identity-skip'));
    await waitFor(() => expect(updateProfileApi).toHaveBeenCalledTimes(1));
    const [, , coords] = updateProfileApi.mock.calls[0];
    expect(coords).toEqual(CENTERED_ROLE);
    expect(sums1(coords)).toBe(true);
  });

  it('a changed name is what gets persisted', async () => {
    tagAc(AC(2));
    render(<IdentityStep />);
    fireEvent.change(screen.getByTestId('identity-name'), { target: { value: 'Jonathan' } });
    fireEvent.click(screen.getByTestId('identity-continue'));
    await waitFor(() => expect(updateProfileApi).toHaveBeenCalledTimes(1));
    expect(updateProfileApi.mock.calls[0][1]).toBe('Jonathan');
  });
});

describe('personaLabel (compass-rose, dec-6)', () => {
  it('the centered default reads as a generalist', () => {
    tagAc(AC(5));
    expect(personaLabel(CENTERED_ROLE)).toBe('Full-stack generalist');
  });
  it('changes in distinct bands toward a tip (lean → strong → all-in)', () => {
    // Near-tip granularity is the point — three different labels along the dev edge.
    expect(personaLabel({ dev: 0.55, design: 0.25, pm: 0.2 })).toBe('Builder');
    expect(personaLabel({ dev: 0.7, design: 0.2, pm: 0.1 })).toBe('Deep in the code');
    expect(personaLabel({ dev: 0.95, design: 0.025, pm: 0.025 })).toBe('All-in builder');
  });
  it('a clear lead with a second leaning in names the modifier', () => {
    expect(personaLabel({ dev: 0.55, design: 0.35, pm: 0.1 })).toContain("designer's eye");
  });
  it('two close leads read as a hybrid', () => {
    expect(personaLabel({ dev: 0.45, design: 0.45, pm: 0.1 })).toBe('Builder / Designer');
  });
});
