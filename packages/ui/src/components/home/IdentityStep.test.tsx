// spec-305 — the journey's identity step (name confirm + role triangle).
// ac-2 — the user confirms/changes the SSO name; it persists.
// ac-5 — the role persists as barycentric weights summing to 1; Skip persists the
//        centered "generalist" default and the step never blocks progress.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';

const updateProfileApi = vi.hoisted(() => vi.fn());
const updateSession = vi.hoisted(() => vi.fn());
const authUser = vi.hoisted(() => ({
  value: { id: 'u-1', name: 'John Doe', email: 'john@example.com' } as {
    id: string;
    name: string;
    email: string;
  },
}));

vi.mock('../../api/client', () => ({ updateProfileApi }));
vi.mock('../AuthContext', () => ({
  useAuth: () => ({
    token: 'fake',
    user: authUser.value,
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
  authUser.value = { id: 'u-1', name: 'John Doe', email: 'john@example.com' };
});

// spec-336: v2 step 0 — greeting from SSO (no name field), the role triangle beside a
// live persona title + description, and Continue. No Skip button.
const AC336 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-336/acs/ac-${n}`;

describe('IdentityStep (v2)', () => {
  it('greets by SSO first name and shows the triangle + live persona (no name field)', () => {
    tagAc(AC(2));
    tagAc(AC336(2));
    render(<IdentityStep />);
    expect(screen.getByTestId('journey-step-identity')).toBeInTheDocument();
    expect(screen.getByText('Hi John, welcome to Memex.')).toBeInTheDocument();
    expect(screen.getByTestId('role-triangle')).toBeInTheDocument();
    expect(screen.getByTestId('persona-label')).toBeInTheDocument();
    expect(screen.getByTestId('persona-description')).toBeInTheDocument();
    // No editable name field in v2 (the SSO name is reused as-is).
    expect(screen.queryByTestId('identity-name')).toBeNull();
    expect(screen.queryByTestId('identity-skip')).toBeNull();
  });

  it('Continue persists the SSO name + role coords (summing to 1) and refreshes the session', async () => {
    tagAc(AC(2));
    tagAc(AC(5));
    tagAc(AC336(2));
    render(<IdentityStep />);
    fireEvent.click(screen.getByTestId('identity-continue'));
    await waitFor(() => expect(updateProfileApi).toHaveBeenCalledTimes(1));
    const [, name, coords] = updateProfileApi.mock.calls[0];
    expect(name).toBe('John Doe'); // reused from SSO, not re-typed
    expect(coords).toEqual(CENTERED_ROLE); // unmoved dot → centered default
    expect(sums1(coords)).toBe(true);
    await waitFor(() => expect(updateSession).toHaveBeenCalledWith({ needsOnboarding: false }));
  });

  it('captures a name for a nameless native-auth user, then persists the typed name', async () => {
    tagAc(AC336(2));
    // Native email sign-ups arrive with no SSO name — the identity step is where they
    // name themselves, so the field appears and Continue is gated until it's filled.
    authUser.value = { id: 'u-2', name: '', email: 'jane@example.com' };
    render(<IdentityStep />);
    const field = screen.getByTestId('identity-name');
    expect(field).toBeInTheDocument();
    expect(screen.getByTestId('identity-continue')).toBeDisabled();
    fireEvent.change(field, { target: { value: 'Jane Roe' } });
    expect(screen.getByTestId('identity-continue')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('identity-continue'));
    await waitFor(() => expect(updateProfileApi).toHaveBeenCalledTimes(1));
    const [, name] = updateProfileApi.mock.calls[0];
    expect(name).toBe('Jane Roe');
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
