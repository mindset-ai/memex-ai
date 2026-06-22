import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { tagAc } from '@memex-ai-ac/vitest';
import type { Tag } from '../api/types';

const AC = 'mindset-prod/memex-building-itself/specs/spec-338/acs';

// Capture track() calls without a live tenant (useTelemetry no-ops without one in
// jsdom, so we stub the hook to observe the call the component makes).
const track = vi.fn();
vi.mock('../hooks/useTelemetry', () => ({
  useTelemetry: () => ({ track, optedOut: false, setOptOut: vi.fn() }),
}));

const CATALOGUE: Tag[] = [
  { id: 't1', memexId: 'm1', scope: 'priority', value: 'high', createdAt: '2025-01-01T00:00:00Z' },
  { id: 't2', memexId: 'm1', scope: 'priority', value: 'low', createdAt: '2025-01-01T00:00:00Z' },
];
vi.mock('../api/client', () => ({
  fetchMemexTags: vi.fn(async () => CATALOGUE),
}));

import { TagFilter } from './TagFilter';

describe('TagFilter — board.tag_filter_applied telemetry', () => {
  beforeEach(() => track.mockClear());

  it('fires board.tag_filter_applied with the new count (count only, no tag values)', async () => {
    tagAc(`${AC}/ac-2`); // props are counts only — never the tag values (no PII/content)
    tagAc(`${AC}/ac-1`); // an in-scope FE interaction emits a registered track() event
    const onChange = vi.fn();
    render(<TagFilter selected={[]} onChange={onChange} />);

    await userEvent.click(screen.getByTestId('tag-filter-toggle'));
    const options = await screen.findAllByTestId('tag-filter-option');
    await userEvent.click(options[0]);

    expect(track).toHaveBeenCalledWith('board.tag_filter_applied', { filterCount: 1 });
    // The props carry only the count — never the tag scope/value (std-35 cl-5).
    const [, props] = track.mock.calls.at(-1)!;
    expect(Object.keys(props as object)).toEqual(['filterCount']);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('fires filterCount: 0 when the selection is cleared', async () => {
    tagAc(`${AC}/ac-1`);
    const onChange = vi.fn();
    render(<TagFilter selected={['priority::high']} onChange={onChange} />);

    await userEvent.click(screen.getByTestId('tag-filter-clear'));

    await waitFor(() =>
      expect(track).toHaveBeenCalledWith('board.tag_filter_applied', { filterCount: 0 }),
    );
  });
});
