import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { QaReportsFilterRail, ALL_TIME, type DateRangeState } from './QaReportsFilterRail';
import type { QaReportFacets } from '../hooks/useQaReports';

const AC_4 = 'mindset-prod/memex-building-itself/specs/spec-286/acs/ac-4';
const AC_5 = 'mindset-prod/memex-building-itself/specs/spec-286/acs/ac-5';

const FACETS: QaReportFacets = {
  total: 7,
  tags: [
    { id: 't-frontend', scope: 'area', value: 'frontend', count: 4 },
    { id: 't-bug', scope: null, value: 'bug', count: 3 },
  ],
};

function renderRail(overrides: Partial<Parameters<typeof QaReportsFilterRail>[0]> = {}) {
  const onSelectTag = vi.fn();
  const onChangeRange = vi.fn();
  render(
    <QaReportsFilterRail
      facets={FACETS}
      loading={false}
      selectedTagId={null}
      onSelectTag={onSelectTag}
      range={ALL_TIME}
      onChangeRange={onChangeRange}
      {...overrides}
    />,
  );
  return { onSelectTag, onChangeRange };
}

describe('QaReportsFilterRail (spec-286)', () => {
  it('ac-4: roots the tree at "All" with the corpus total and one counted node per tag', () => {
    tagAc(AC_4);
    renderRail();

    const all = screen.getByTestId('qa-reports-tag-all');
    expect(all).toHaveTextContent('All');
    expect(all).toHaveTextContent('7');

    const nodes = screen.getAllByTestId('qa-reports-tag-node');
    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toHaveTextContent('frontend');
    const counts = screen.getAllByTestId('qa-reports-tag-count').map((n) => n.textContent);
    expect(counts).toEqual(['4', '3']);
  });

  it('ac-4: clicking a tag selects it; clicking All clears the selection', () => {
    tagAc(AC_4);
    const { onSelectTag } = renderRail({ selectedTagId: 't-frontend' });

    // The selected node is marked pressed.
    const frontend = screen
      .getAllByTestId('qa-reports-tag-node')
      .find((n) => n.getAttribute('data-tag-id') === 't-frontend')!;
    expect(frontend).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(
      screen
        .getAllByTestId('qa-reports-tag-node')
        .find((n) => n.getAttribute('data-tag-id') === 't-bug')!,
    );
    expect(onSelectTag).toHaveBeenCalledWith('t-bug');

    fireEvent.click(screen.getByTestId('qa-reports-tag-all'));
    expect(onSelectTag).toHaveBeenCalledWith(null);
  });

  it('ac-5: quick ranges emit a preset + lower bound; "All time" clears the window', () => {
    tagAc(AC_5);
    const { onChangeRange } = renderRail({ range: { preset: 'week', from: '2026-06-06T00:00:00.000Z' } });

    fireEvent.click(screen.getByTestId('qa-reports-range-month'));
    const monthArg = onChangeRange.mock.calls.at(-1)![0] as DateRangeState;
    expect(monthArg.preset).toBe('month');
    expect(typeof monthArg.from).toBe('string');
    expect(monthArg.to).toBeUndefined();

    fireEvent.click(screen.getByTestId('qa-reports-range-all'));
    expect(onChangeRange).toHaveBeenLastCalledWith(ALL_TIME);
  });

  it('ac-5: a custom from/to range emits inclusive ISO bounds', () => {
    tagAc(AC_5);
    const { onChangeRange } = renderRail();

    fireEvent.change(screen.getByTestId('qa-reports-range-from'), {
      target: { value: '2026-01-15' },
    });
    const arg = onChangeRange.mock.calls.at(-1)![0] as DateRangeState;
    expect(arg.preset).toBe('custom');
    expect(arg.from).toBe('2026-01-15T00:00:00.000Z');

    fireEvent.change(screen.getByTestId('qa-reports-range-to'), {
      target: { value: '2026-01-31' },
    });
    const arg2 = onChangeRange.mock.calls.at(-1)![0] as DateRangeState;
    // End-of-day so the chosen day is inclusive.
    expect(arg2.to).toBe('2026-01-31T23:59:59.999Z');
  });
});
