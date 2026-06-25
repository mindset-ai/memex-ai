// spec-234 — Emission Keys differentiates the two key types: a permanent (CI) key and
// an ephemeral (agent) key, and the ephemeral key shows its expiry + the Spec it is
// scoped to.
//
// UPDATED by spec-309 (dec-5): the differentiation moved from a per-row "Type" cell to
// the CI/Agent type toggle + type-aware columns. ac-8 (the two types render
// distinguishably) and ac-20 (the agent key shows its expiry + scoped Spec) still hold —
// they're now verified against the toggle + the Agent view's Spec/Expires columns.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { EmissionKeysSection } from './EmissionKeysSection';
import type { EmissionKeySummary } from '../api/client';

const AC_8 = 'mindset-prod/memex-building-itself/specs/spec-234/acs/ac-8';
const AC_20 = 'mindset-prod/memex-building-itself/specs/spec-234/acs/ac-20';

const mockList = vi.fn();

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return {
    ...actual,
    listEmissionKeysApi: (...args: unknown[]) => mockList(...args),
  };
});

vi.mock('./AuthContext', () => ({
  useAuth: () => ({ token: 'tok-1' }),
}));

function key(over: Partial<EmissionKeySummary> = {}): EmissionKeySummary {
  return {
    id: crypto.randomUUID(),
    name: 'a key',
    prefix: 'mxk_abcd1234',
    lastUsedAt: null,
    revokedAt: null,
    createdAt: new Date().toISOString(),
    expiresAt: null,
    scopedSpecHandle: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('EmissionKeysSection — two-key differentiation (spec-234, via spec-309 toggle)', () => {
  it('renders a permanent CI key and an ephemeral agent key distinguishably [ac-8]', async () => {
    tagAc(AC_8);
    mockList.mockResolvedValue([
      key({ name: 'pythonia CI' }), // permanent: expiresAt null
      key({
        name: 'agent key',
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        scopedSpecHandle: 'spec-234',
      }),
    ]);

    render(<EmissionKeysSection />);

    // The two types are surfaced as distinct, separately-counted segments — CI 1 / Agent 1.
    const ci = await screen.findByRole('radio', { name: /CI/ });
    const agent = screen.getByRole('radio', { name: /Agent/ });
    expect(ci).toHaveTextContent('1');
    expect(agent).toHaveTextContent('1');

    // Default CI view shows the permanent key, not the agent key.
    expect(screen.getByText('pythonia CI')).toBeInTheDocument();
    expect(screen.queryByText('agent key')).not.toBeInTheDocument();

    // Switching to Agent shows the agent key and hides the CI key — the two render
    // in distinct, type-appropriate views.
    fireEvent.click(agent);
    expect(await screen.findByText('agent key')).toBeInTheDocument();
    expect(screen.queryByText('pythonia CI')).not.toBeInTheDocument();
  });

  it('shows the ephemeral key’s expiry and the Spec it is scoped to [ac-20]', async () => {
    tagAc(AC_20);
    mockList.mockResolvedValue([
      key({
        name: 'agent key',
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        scopedSpecHandle: 'spec-234',
      }),
    ]);

    render(<EmissionKeysSection />);

    // Move to the Agent view (the only place these columns exist).
    fireEvent.click(await screen.findByRole('radio', { name: /Agent/ }));

    // Expiry is surfaced (relative, ~2h) under its own Expires column…
    const expires = await screen.findByTestId('emission-key-expires');
    expect(within(expires).getByText(/in \d+h/)).toBeInTheDocument();
    // …and the scoped Spec under its own Spec column.
    const spec = screen.getByTestId('emission-key-spec');
    expect(within(spec).getByText('spec-234')).toBeInTheDocument();
  });
});
