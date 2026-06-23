// spec-309 — filter the emission-keys Active table by type (CI vs Agent), CI by default,
// with per-type counts, per-type empty states, and type-aware columns (Agent view
// promotes Spec + Expires to their own columns and drops Type).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { EmissionKeysSection } from './EmissionKeysSection';
import type { EmissionKeySummary } from '../api/client';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-309/acs/ac-${n}`;

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

const ci = (name: string) => key({ name });
const agent = (name: string, spec: string) =>
  key({
    name,
    scopedSpecHandle: spec,
    expiresAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString(),
  });

function headerLabels(): string[] {
  const table = screen.getByTestId('emission-keys-table');
  return within(table)
    .getAllByRole('columnheader')
    .map((th) => th.textContent?.trim() ?? '');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('spec-309 — type filter toggle', () => {
  it('defaults to CI, shows per-type counts, and marks the selection [ac-6, ac-9, ac-10, ac-1, ac-3]', async () => {
    tagAc(AC(6));
    tagAc(AC(9));
    tagAc(AC(10));
    tagAc(AC(1));
    tagAc(AC(3));
    mockList.mockResolvedValue([ci('ci-a'), ci('ci-b'), agent('ag-a', 'spec-50')]);

    render(<EmissionKeysSection />);

    // A radiogroup with CI / Agent segments sits above the table.
    const group = await screen.findByRole('radiogroup', { name: /key type/i });
    expect(group).toBeInTheDocument();
    const ciSeg = within(group).getByRole('radio', { name: /CI/ });
    const agentSeg = within(group).getByRole('radio', { name: /Agent/ });

    // CI is the default selection (and it's conveyed, not just coloured).
    expect(ciSeg).toHaveAttribute('aria-checked', 'true');
    expect(agentSeg).toHaveAttribute('aria-checked', 'false');

    // Per-type counts (CI 2 / Agent 1).
    expect(ciSeg).toHaveTextContent('2');
    expect(agentSeg).toHaveTextContent('1');

    // The default CI view is what renders.
    expect(screen.getByTestId('emission-keys-table')).toHaveAttribute('data-view', 'permanent');
  });

  it('filters to the selected type client-side with no extra API call [ac-7, ac-2, ac-8, ac-5]', async () => {
    tagAc(AC(7));
    tagAc(AC(2));
    tagAc(AC(8));
    tagAc(AC(5));
    mockList.mockResolvedValue([ci('ci-only'), agent('agent-only', 'spec-80')]);

    render(<EmissionKeysSection />);

    // Default CI view: CI key visible, agent key hidden.
    expect(await screen.findByText('ci-only')).toBeInTheDocument();
    expect(screen.queryByText('agent-only')).not.toBeInTheDocument();
    expect(mockList).toHaveBeenCalledTimes(1);

    // Switch to Agent — the rows swap, and NO new fetch happens (client-side filter).
    fireEvent.click(screen.getByRole('radio', { name: /Agent/ }));
    expect(await screen.findByText('agent-only')).toBeInTheDocument();
    expect(screen.queryByText('ci-only')).not.toBeInTheDocument();
    expect(mockList).toHaveBeenCalledTimes(1);

    // Generate form + a revoke control remain available regardless of filter.
    expect(screen.getByRole('button', { name: /Generate key/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Revoke/i })).toBeInTheDocument();
  });

  it('moves selection with arrow keys [ac-5, ac-7]', async () => {
    tagAc(AC(5));
    tagAc(AC(7));
    mockList.mockResolvedValue([ci('ci-a'), agent('ag-a', 'spec-50')]);

    render(<EmissionKeysSection />);
    const group = await screen.findByRole('radiogroup', { name: /key type/i });

    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(within(group).getByRole('radio', { name: /Agent/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );

    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(within(group).getByRole('radio', { name: /CI/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });
});

describe('spec-309 — type-aware columns', () => {
  it('CI view shows only the permanent-key columns [ac-15]', async () => {
    tagAc(AC(15));
    mockList.mockResolvedValue([ci('ci-a'), agent('ag-a', 'spec-50')]);

    render(<EmissionKeysSection />);
    await screen.findByTestId('emission-keys-table');

    // Name · Key · Last used · Created · (revoke) — no Type, Spec, or Expires.
    const labels = headerLabels();
    expect(labels).toEqual(['Name', 'Key', 'Last used', 'Created', '']);
  });

  it('Agent view promotes Spec + Expires to columns and drops Type [ac-13, ac-12]', async () => {
    tagAc(AC(13));
    tagAc(AC(12));
    mockList.mockResolvedValue([ci('ci-a'), agent('ag-a', 'spec-50')]);

    render(<EmissionKeysSection />);
    fireEvent.click(await screen.findByRole('radio', { name: /Agent/ }));

    const labels = headerLabels();
    expect(labels).toEqual(['Name', 'Spec', 'Key', 'Expires', 'Last used', 'Created', '']);
    expect(labels).not.toContain('Type');
  });

  it('Agent view renders the scoped Spec and formatted expiry in their columns [ac-14]', async () => {
    tagAc(AC(14));
    mockList.mockResolvedValue([agent('ag-a', 'spec-99')]);

    render(<EmissionKeysSection />);
    fireEvent.click(await screen.findByRole('radio', { name: /Agent/ }));

    expect(within(await screen.findByTestId('emission-key-spec')).getByText('spec-99')).toBeInTheDocument();
    expect(within(screen.getByTestId('emission-key-expires')).getByText(/in \d+h/)).toBeInTheDocument();
  });
});

describe('spec-309 — revoked section + counts [ac-11]', () => {
  it('leaves the Revoked section unfiltered and excludes revoked keys from the counts', async () => {
    tagAc(AC(11));
    mockList.mockResolvedValue([
      ci('ci-a'),
      agent('ag-a', 'spec-50'),
      key({ name: 'old-revoked-key', revokedAt: new Date().toISOString() }),
    ]);

    render(<EmissionKeysSection />);

    // Counts reflect ONLY active keys (revoked excluded): CI 1 / Agent 1.
    const group = await screen.findByRole('radiogroup', { name: /key type/i });
    expect(within(group).getByRole('radio', { name: /CI/ })).toHaveTextContent('1');
    expect(within(group).getByRole('radio', { name: /Agent/ })).toHaveTextContent('1');

    // The revoked key shows in the CI (default) view…
    expect(screen.getByText('old-revoked-key')).toBeInTheDocument();
    // …and still shows after switching to Agent — the filter doesn't touch Revoked.
    fireEvent.click(within(group).getByRole('radio', { name: /Agent/ }));
    expect(screen.getByText('old-revoked-key')).toBeInTheDocument();
  });
});

describe('spec-309 — per-type empty states [ac-4]', () => {
  it('shows the CI empty state when there are only agent keys', async () => {
    tagAc(AC(4));
    mockList.mockResolvedValue([agent('ag-a', 'spec-50')]); // 0 CI, 1 agent

    render(<EmissionKeysSection />);

    // Default CI view is empty → CI-specific empty copy, not a blank table.
    const empty = await screen.findByTestId('emission-keys-empty-permanent');
    expect(empty).toHaveTextContent(/No CI keys yet/i);
    expect(screen.queryByTestId('emission-keys-table')).not.toBeInTheDocument();
  });

  it('shows the Agent empty state when there are only CI keys', async () => {
    tagAc(AC(4));
    mockList.mockResolvedValue([ci('ci-a')]); // 1 CI, 0 agent

    render(<EmissionKeysSection />);
    fireEvent.click(await screen.findByRole('radio', { name: /Agent/ }));

    const empty = await screen.findByTestId('emission-keys-empty-ephemeral');
    expect(empty).toHaveTextContent(/created automatically/i);
    expect(screen.queryByTestId('emission-keys-table')).not.toBeInTheDocument();
  });
});
