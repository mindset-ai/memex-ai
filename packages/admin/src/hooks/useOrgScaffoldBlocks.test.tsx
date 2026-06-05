// spec-103 t-4: tests for useOrgScaffoldBlocks — the wiring that lets an Org's
// appended guidance reach a live Prompt Button without code changes.
//
// The hook resolves the current Org (getOrgApi) and loads the merged scaffold
// (fetchScaffold), returning the Org GuidanceBlock array. Both the client and
// scaffold modules are mocked so this is fully isolated — no real network.

import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useOrgScaffoldBlocks } from './useOrgScaffoldBlocks';
import { getOrgApi } from '../api/client';
import { fetchScaffold } from '../api/scaffold';
import type { GuidanceBlock } from '@memex/shared';
import { tagAc } from '@memex-ai-ac/vitest';

// ac-2: an Org administrator can append guidance to any button without code
// changes — this hook is the surface-side wiring that delivers those appends.
const AC_2 = 'mindset-prod/memex-building-itself/specs/spec-103/acs/ac-2';

vi.mock('../api/client', () => ({
  getOrgApi: vi.fn(),
}));

vi.mock('../api/scaffold', () => ({
  fetchScaffold: vi.fn(),
}));

// The hook reads `token` off useAuth(); stub it so no AuthProvider is needed.
vi.mock('../components/AuthContext', () => ({
  useAuth: () => ({ token: 'tok' }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

// Tiny probe component: surfaces the hook's return value through a data attr so
// the test can assert on it without rendering a real consumer.
function Probe({ onBlocks }: { onBlocks: (b: readonly GuidanceBlock[]) => void }) {
  const blocks = useOrgScaffoldBlocks();
  onBlocks(blocks);
  return null;
}

function makeOrgBlock(id: string, button: string): GuidanceBlock & { id: string } {
  return {
    id,
    kind: 'guidance_block',
    source: 'org',
    target: { button },
    text: `org guidance for ${button}`,
    rationale: `rationale for ${button}`,
    enabled: true,
    order: 0,
  };
}

describe('useOrgScaffoldBlocks', () => {
  it('returns the Org GuidanceBlocks once the Org resolves and scaffold loads', async () => {
    tagAc(AC_2);
    const orgBlocks = [makeOrgBlock('row-1', 'verify-spec')];
    vi.mocked(getOrgApi).mockResolvedValue({ id: 'org-1' } as Awaited<
      ReturnType<typeof getOrgApi>
    >);
    vi.mocked(fetchScaffold).mockResolvedValue({
      base: { phases: [], gates: [], promptButtons: [] } as never,
      org: orgBlocks as never,
    });

    let captured: readonly GuidanceBlock[] = [{ marker: true } as never];
    render(<Probe onBlocks={(b) => (captured = b)} />);

    await waitFor(() => expect(captured).toHaveLength(1));
    expect(captured).toEqual(orgBlocks);
    // The Org id from getOrgApi must drive the scaffold fetch.
    expect(vi.mocked(fetchScaffold)).toHaveBeenCalledWith('org-1');
  });

  it('falls back to [] when the Org cannot be resolved (personal memex / non-member)', async () => {
    tagAc(AC_2);
    vi.mocked(getOrgApi).mockRejectedValue(new Error('404'));

    let captured: readonly GuidanceBlock[] = [{ marker: true } as never];
    render(<Probe onBlocks={(b) => (captured = b)} />);

    // getOrgApi rejected, so fetchScaffold must never run and the result is [].
    await waitFor(() => expect(vi.mocked(getOrgApi)).toHaveBeenCalled());
    expect(captured).toEqual([]);
    expect(vi.mocked(fetchScaffold)).not.toHaveBeenCalled();
  });

  it('falls back to [] when the scaffold fetch fails', async () => {
    tagAc(AC_2);
    vi.mocked(getOrgApi).mockResolvedValue({ id: 'org-1' } as Awaited<
      ReturnType<typeof getOrgApi>
    >);
    vi.mocked(fetchScaffold).mockRejectedValue(new Error('boom'));

    let captured: readonly GuidanceBlock[] = [{ marker: true } as never];
    render(<Probe onBlocks={(b) => (captured = b)} />);

    await waitFor(() => expect(vi.mocked(fetchScaffold)).toHaveBeenCalled());
    expect(captured).toEqual([]);
  });
});
