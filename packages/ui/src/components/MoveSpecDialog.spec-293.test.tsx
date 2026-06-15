// spec-293 dec-2/dec-3 (ac-13): the Move-spec dialog no longer offers per-artifact
// opt-out checkboxes (a Spec moves whole) and refers to "Comments", never
// "Section comments".

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import type { MembershipSummary, SessionPayload } from '../api/client';

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-293/acs/ac-${n}`;

let mockSession: SessionPayload | null = null;

vi.mock('./AuthContext', async () => {
  const real = await vi.importActual<typeof import('./AuthContext')>('./AuthContext');
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
  const real = await vi.importActual<typeof import('../utils/tenantUrl')>('../utils/tenantUrl');
  return {
    ...real,
    getCurrentTenant: () => ({ namespace: 'acme', memex: 'memex-one' }),
  };
});

import { MoveSpecDialog } from './MoveSpecDialog';

function session(): SessionPayload {
  const dest: MembershipSummary = {
    memexId: 'mx-two',
    slug: 'acme',
    memexSlug: 'memex-two',
    name: 'Acme Inc',
    kind: 'team',
    role: 'administrator',
  };
  return {
    user: { id: 'u-1', email: 'alice@example.com', name: 'Alice', status: 'active', emailVerified: true },
    memberships: [
      { ...dest, memexId: 'mx-one', memexSlug: 'memex-one' },
      dest,
    ],
    currentMemexId: 'mx-one',
    currentRole: 'administrator',
    needsOnboarding: false,
    hiddenFeatures: [],
  };
}

describe('MoveSpecDialog whole-move shape (spec-293)', () => {
  beforeEach(() => {
    mockSession = session();
  });
  afterEach(() => {
    cleanup();
    mockSession = null;
  });

  it('ac-13: renders no opt-out checkboxes and says "Comments", not "Section comments"', () => {
    tagAc(AC(13));
    tagAc(AC(3)); // scope: dialog reads "Comments" and treats all comments uniformly
    render(
      <MoveSpecDialog
        docId="doc-1"
        title="Publish the DB schema"
        decisionCount={1}
        taskCount={4}
        commentCount={2}
        onClose={() => {}}
      />,
    );

    // No per-artifact opt-out checkboxes.
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);

    // "Comments" present; "Section comments" gone.
    expect(screen.getByText(/Comments/)).toBeTruthy();
    expect(screen.queryByText(/Section comments/i)).toBeNull();

    // The read-only "what moves" summary is shown.
    expect(screen.getByText(/What moves/i)).toBeTruthy();
  });
});
