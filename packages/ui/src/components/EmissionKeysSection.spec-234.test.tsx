// spec-234 t-3 — Settings → Emission Keys differentiates the two key types.
// A permanent (CI) key and an ephemeral (agent) key render distinguishably, and the
// ephemeral key shows its expiry + the Spec it is scoped to.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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

describe('EmissionKeysSection — two-key differentiation (spec-234)', () => {
  it('renders a permanent CI key and an ephemeral agent key distinguishably [ac-8]', async () => {
    tagAc(AC_8);
    mockList.mockResolvedValue([
      key({ name: 'pythonia CI' }), // permanent: expiresAt null
      key({
        name: 'agent · spec-234 · 2026-06-11',
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        scopedSpecHandle: 'spec-234',
      }),
    ]);

    render(<EmissionKeysSection />);

    // Both type cells render, with distinct kinds.
    const cells = await screen.findAllByTestId('emission-key-type');
    const kinds = cells.map((c) => c.getAttribute('data-kind')).sort();
    expect(kinds).toEqual(['ephemeral', 'permanent']);

    // The permanent key is labelled CI; the ephemeral one Agent.
    const permanent = cells.find((c) => c.getAttribute('data-kind') === 'permanent')!;
    const ephemeral = cells.find((c) => c.getAttribute('data-kind') === 'ephemeral')!;
    expect(within(permanent).getByText('CI')).toBeInTheDocument();
    expect(within(ephemeral).getByText('Agent')).toBeInTheDocument();
  });

  it('shows the ephemeral key’s expiry and the Spec it is scoped to [ac-20]', async () => {
    tagAc(AC_20);
    mockList.mockResolvedValue([
      key({
        name: 'agent · spec-234 · 2026-06-11',
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        scopedSpecHandle: 'spec-234',
      }),
    ]);

    render(<EmissionKeysSection />);

    const cell = (await screen.findAllByTestId('emission-key-type')).find(
      (c) => c.getAttribute('data-kind') === 'ephemeral',
    )!;
    // Expiry is surfaced (relative, ~2h) and the scoped Spec is named.
    expect(within(cell).getByText(/expires in \d+h/)).toBeInTheDocument();
    expect(within(cell).getByText(/spec-234/)).toBeInTheDocument();
  });
});
