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
const AC372 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-372/acs/ac-${n}`;

describe('IdentityStep (v2)', () => {
  it('spec-372 ac-29: the persona panel has the "So you’re a…" eyebrow and a semibold (not black) role title', () => {
    tagAc(AC372(29));
    render(<IdentityStep />);
    expect(screen.getByText("So you're a…")).toBeInTheDocument();
    const label = screen.getByTestId('persona-label');
    expect(label.className).toContain('font-semibold');
    expect(label.className).not.toContain('font-black');
  });

  it('greets by SSO first name and shows the triangle + live persona (no name field)', () => {
    tagAc(AC(2));
    tagAc(AC336(2));
    render(<IdentityStep />);
    expect(screen.getByTestId('journey-step-identity')).toBeInTheDocument();
    expect(screen.getByText('Hi John, welcome to Memex AI.')).toBeInTheDocument();
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

  it('spec-372 issue-4: the name field shows a confirm tick only after typing, and the tick submits', async () => {
    authUser.value = { id: 'u-2', name: '', email: 'jane@example.com' };
    render(<IdentityStep />);
    // Hidden while the field is empty.
    expect(screen.queryByTestId('identity-name-confirm')).toBeNull();
    // Appears once at least one character is typed.
    fireEvent.change(screen.getByTestId('identity-name'), { target: { value: 'Jane' } });
    const confirm = screen.getByTestId('identity-name-confirm');
    expect(confirm).toBeInTheDocument();
    // Clicking it submits like Continue (persists the typed name).
    fireEvent.click(confirm);
    await waitFor(() => expect(updateProfileApi).toHaveBeenCalledTimes(1));
    expect(updateProfileApi.mock.calls[0][1]).toBe('Jane');
  });
});

// spec-372 issue-2 — guard the two layout fixes so a future change can't silently
// reintroduce the triangle "jump" or un-align its left point:
//  • the two-column row top-aligns (items-start), so the fixed-size triangle is NOT
//    re-centred when the variable-height persona panel reflows as the dot moves;
//  • the triangle SVG left-aligns its left (Design) vertex to the content's left edge —
//    no mx-auto, viewBox origin at 0 (Design vertex at x=0), overflow-visible so the
//    vertex marker isn't clipped.
describe('IdentityStep — issue-2 layout (no jump; left-aligned triangle)', () => {
  it('the triangle/persona row top-aligns (items-start, never items-center)', () => {
    const { container } = render(<IdentityStep />);
    const row = container.querySelector('div.flex.flex-wrap');
    expect(row).not.toBeNull();
    expect(row!.className).toContain('items-start');
    expect(row!.className).not.toContain('items-center');
  });

  it('the triangle SVG is left-aligned: no mx-auto, viewBox origin 0, overflow-visible', () => {
    render(<IdentityStep />);
    const svg = screen.getByTestId('role-triangle');
    expect(svg.getAttribute('viewBox')).toBe('0 0 240 226'); // Design vertex at x=0
    expect(svg.getAttribute('class')).toContain('overflow-visible');
    expect(svg.getAttribute('class')).not.toContain('mx-auto');
  });
});

describe('personaLabel (compass-rose, dec-6)', () => {
  it('the centered default reads as a generalist', () => {
    tagAc(AC(5));
    expect(personaLabel(CENTERED_ROLE)).toBe('Full stack generalist'); // spec-372 t-12: v3 drops the hyphen
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
