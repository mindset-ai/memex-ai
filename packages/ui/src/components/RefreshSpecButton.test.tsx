import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { tagAc } from '@memex-ai-ac/vitest';
import { BASE_SCAFFOLD } from '@memex/shared';
import {
  RefreshSpecButton,
  isSpecNarrativeStale,
} from './RefreshSpecButton';
import type { Decision, SpecStatus } from '../api/types';

const mockSendMessage = vi.fn();

vi.mock('./ChatContext', () => ({
  useChat: () => ({ sendMessage: mockSendMessage }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

function makeDecision(over: Partial<Decision> = {}): Decision {
  return {
    id: `d-${Math.random()}`,
    docId: 'doc-1',
    seq: 1,
    title: 'Pick a database',
    context: null,
    status: 'open',
    resolution: null,
    resolvedAt: null,
    options: null,
    chosenOptionIndex: null,
    createdAt: '2026-05-01T00:00:00.000Z',
    ...over,
  };
}

describe('isSpecNarrativeStale', () => {
  it('false when there are no decisions (nothing to consolidate)', () => {
    expect(isSpecNarrativeStale('2026-05-01T00:00:00.000Z', [])).toBe(false);
    expect(isSpecNarrativeStale(null, [])).toBe(false);
  });

  it('true when never consolidated and at least one decision exists', () => {
    expect(isSpecNarrativeStale(null, [makeDecision()])).toBe(true);
    expect(isSpecNarrativeStale(undefined, [makeDecision()])).toBe(true);
  });

  it('true when a decision was created after the consolidation timestamp', () => {
    const consolidatedAt = '2026-05-01T00:00:00.000Z';
    const dec = makeDecision({ createdAt: '2026-05-02T00:00:00.000Z' });
    expect(isSpecNarrativeStale(consolidatedAt, [dec])).toBe(true);
  });

  it('true when a decision was resolved after the consolidation timestamp', () => {
    const consolidatedAt = '2026-05-01T00:00:00.000Z';
    const dec = makeDecision({
      createdAt: '2026-04-01T00:00:00.000Z',
      resolvedAt: '2026-05-02T00:00:00.000Z',
      status: 'resolved',
    });
    expect(isSpecNarrativeStale(consolidatedAt, [dec])).toBe(true);
  });

  it('false when every decision is older than the consolidation timestamp', () => {
    const consolidatedAt = '2026-05-10T00:00:00.000Z';
    const decs = [
      makeDecision({ createdAt: '2026-04-01T00:00:00.000Z' }),
      makeDecision({
        createdAt: '2026-04-01T00:00:00.000Z',
        resolvedAt: '2026-05-09T00:00:00.000Z',
        status: 'resolved',
      }),
    ];
    expect(isSpecNarrativeStale(consolidatedAt, decs)).toBe(false);
  });
});

function renderRefresh(over: {
  phase?: SpecStatus;
  narrativeLastConsolidatedAt?: string | null;
  decisions?: Decision[];
} = {}) {
  return render(
    <RefreshSpecButton
      phase={over.phase ?? 'build'}
      narrativeLastConsolidatedAt={over.narrativeLastConsolidatedAt ?? null}
      decisions={over.decisions ?? [makeDecision()]}
    />,
  );
}

describe('RefreshSpecButton — visibility', () => {
  it('hidden in `draft` even if the narrative is stale', () => {
    renderRefresh({ phase: 'draft' }); // null consolidation + 1 decision = stale
    expect(
      screen.queryByRole('button', { name: /update Spec narrative/i }),
    ).not.toBeInTheDocument();
  });

  it('hidden in `done` even if the narrative is stale', () => {
    renderRefresh({ phase: 'done' });
    expect(
      screen.queryByRole('button', { name: /update Spec narrative/i }),
    ).not.toBeInTheDocument();
  });

  it('hidden when there are no stale decisions (consolidation newer than every decision)', () => {
    renderRefresh({
      phase: 'build',
      narrativeLastConsolidatedAt: '2026-05-10T00:00:00.000Z',
      decisions: [makeDecision({ createdAt: '2026-04-01T00:00:00.000Z' })],
    });
    expect(
      screen.queryByRole('button', { name: /update Spec narrative/i }),
    ).not.toBeInTheDocument();
  });

  it('visible in `specify` / `build` / `verify` when the narrative is stale', () => {
    for (const phase of ['specify', 'build', 'verify'] as const) {
      const { unmount } = renderRefresh({ phase });
      expect(
        screen.getByRole('button', { name: /update Spec narrative/i }),
      ).toBeInTheDocument();
      unmount();
    }
  });
});

describe('RefreshSpecButton — click behavior', () => {
  it('seeds the chat with the consolidation prompt', async () => {
    const user = userEvent.setup();
    renderRefresh();

    await user.click(
      screen.getByRole('button', { name: /update Spec narrative/i }),
    );

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).toHaveBeenCalledWith(
      expect.stringMatching(/Update the spec narrative/i),
    );
  });
});

// spec-196 t-3 (ac-11): the orphaned top-bar button stays verbatim-in-sync
// with the LIVE home of this copy — the scaffold's opening-refresh-narrative
// helper. A drift between the two would ship two different consolidation
// prompts depending on which surface fires.
describe('spec-196 — dec-3 copy kept in sync with the scaffold node', () => {
  const AC11 = 'mindset-prod/memex-building-itself/specs/spec-196/acs/ac-11';

  it('the clipboard prompt equals the dec-3 string exactly and matches the scaffold node', async () => {
    tagAc(AC11);
    const user = userEvent.setup();
    renderRefresh();
    await user.click(screen.getByRole('button', { name: /update spec narrative/i }));

    const expected =
      'Update the spec narrative — walk every decision modified since the last consolidation and update the affected sections so the narrative reflects what was decided.';
    expect(mockSendMessage).toHaveBeenCalledWith(expected);
    const node = BASE_SCAFFOLD.promptButtons.find((b) => b.id === 'opening-refresh-narrative');
    expect(node?.text).toBe(expected);
  });
});
