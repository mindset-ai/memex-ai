// spec-288 — the Move spec dialog's destination dropdown must list every OTHER
// memex in the org (plus the user's personal one) when viewing from INSIDE the
// org, excluding only the exact current memex. The earlier bug filtered by
// namespace slug alone, which dropped every org sibling (they share one slug).
//
// These tests drive MoveSpecDialog directly with a mocked session + current
// tenant and assert the rendered <option> set, covering ac-1…ac-4.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, within, cleanup } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import type { MembershipSummary, SessionPayload } from '../api/client';

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-288/acs/ac-${n}`;

// We're viewing acme/memex-one — an org memex with siblings.
let mockSession: SessionPayload | null = null;

vi.mock('./AuthContext', async () => {
  const real =
    await vi.importActual<typeof import('./AuthContext')>('./AuthContext');
  return {
    ...real,
    useAuth: () => ({
      session: mockSession,
      user: { name: 'Alice', email: 'alice@example.com', picture: '' },
      token: 'fake-token',
      isAuthenticated: true,
      authError: null,
      logout: vi.fn(),
      updateSession: vi.fn(),
      acceptSession: vi.fn(),
    }),
  };
});

vi.mock('../utils/tenantUrl', async () => {
  const real =
    await vi.importActual<typeof import('../utils/tenantUrl')>(
      '../utils/tenantUrl',
    );
  return {
    ...real,
    // Pretend the URL is /acme/memex-one/... — viewing inside the org.
    getCurrentTenant: () => ({ namespace: 'acme', memex: 'memex-one' }),
  };
});

import { MoveSpecDialog } from './MoveSpecDialog';

function m(over: Partial<MembershipSummary> & Pick<MembershipSummary, 'memexId'>): MembershipSummary {
  return {
    slug: 'acme',
    memexSlug: 'memex-x',
    name: 'Acme Inc',
    kind: 'team',
    role: 'administrator',
    ...over,
  };
}

// Order is deliberate: the first eligible destination (memex-two) is what the
// default-selection effect should land on (ac-4).
const MEMBERSHIPS: MembershipSummary[] = [
  // The memex we're currently on — excluded, never a destination (ac-2).
  m({ memexId: 'mx-one', memexSlug: 'memex-one' }),
  // Org siblings sharing the 'acme' namespace slug — MUST remain (ac-1, ac-2).
  m({ memexId: 'mx-two', memexSlug: 'memex-two', accessLevel: 'write' }),
  m({ memexId: 'mx-three', memexSlug: 'memex-three', role: 'member', accessLevel: 'write' }),
  // The user's personal memex — always a valid destination (ac-1).
  m({
    memexId: 'mx-personal',
    slug: 'alice',
    memexSlug: 'personal',
    name: 'Personal Memex',
    kind: 'personal',
  }),
  // A visited, read-only memex — cannot be a move target (ac-3).
  m({
    memexId: 'mx-visited',
    slug: 'open-source',
    memexSlug: 'public-memex',
    name: 'Open Source',
    role: 'member',
    source: 'visited',
    accessLevel: 'read',
  }),
  // A pre-spec-111 row with no accessLevel — treated as write, so eligible (ac-3).
  m({
    memexId: 'mx-legacy',
    slug: 'legacy',
    memexSlug: 'legacy-memex',
    name: 'Legacy Org',
    role: 'member',
  }),
];

function makeSession(memberships: MembershipSummary[]): SessionPayload {
  return {
    user: {
      id: 'u-1',
      email: 'alice@example.com',
      name: 'Alice',
      status: 'active',
      emailVerified: true,
    },
    memberships,
    currentMemexId: 'mx-one',
    currentRole: 'administrator',
    needsOnboarding: false,
    hiddenFeatures: [],
  };
}

function renderDialog() {
  return render(
    <MoveSpecDialog docId="doc-1" title="Publish the DB schema" onClose={() => {}} />,
  );
}

function optionValues(): string[] {
  const select = screen.getByRole('combobox') as HTMLSelectElement;
  return within(select)
    .getAllByRole('option')
    .map((o) => (o as HTMLOptionElement).value);
}

describe('MoveSpecDialog destination dropdown (spec-288)', () => {
  beforeEach(() => {
    mockSession = makeSession(MEMBERSHIPS);
  });
  afterEach(() => {
    cleanup();
    mockSession = null;
  });

  it('lists every org sibling plus the personal memex when viewing inside the org', () => {
    renderDialog();
    const select = screen.getByRole('combobox');
    const labels = within(select)
      .getAllByRole('option')
      .map((o) => o.textContent?.trim());

    // Org siblings render "OrgName · memex-slug"; personal renders "name (personal)".
    expect(labels).toContain('Acme Inc · memex-two');
    expect(labels).toContain('Acme Inc · memex-three');
    expect(labels).toContain('Personal Memex (personal)');
    tagAc(AC(1));
  });

  it('excludes only the exact current memex, not every memex sharing its namespace', () => {
    renderDialog();
    const values = optionValues();

    // The current memex is gone…
    expect(values).not.toContain('mx-one');
    // …but its org siblings (same 'acme' slug) survive — the regression guard.
    expect(values).toContain('mx-two');
    expect(values).toContain('mx-three');
    tagAc(AC(2));
  });

  it('drops read-only (visited) memexes but keeps rows with an absent accessLevel', () => {
    renderDialog();
    const values = optionValues();

    expect(values).not.toContain('mx-visited'); // read-only → not a move target
    expect(values).toContain('mx-legacy'); // accessLevel absent ⇒ treated as write
    tagAc(AC(3));
  });

  it('auto-selects a valid destination once the session resolves, enabling Move', async () => {
    // Session not yet loaded at mount → no dropdown, Move disabled.
    mockSession = null;
    const { rerender } = renderDialog();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Move' })).toBeDisabled();

    // Session arrives → effect picks the first eligible destination.
    mockSession = makeSession(MEMBERSHIPS);
    rerender(
      <MoveSpecDialog docId="doc-1" title="Publish the DB schema" onClose={() => {}} />,
    );

    const select = (await screen.findByRole('combobox')) as HTMLSelectElement;
    expect(select.value).toBe('mx-two'); // first eligible destination
    expect(optionValues()).toContain(select.value);
    expect(screen.getByRole('button', { name: 'Move' })).toBeEnabled();
    tagAc(AC(4));
  });
});
