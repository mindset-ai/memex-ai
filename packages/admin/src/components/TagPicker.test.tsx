import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TagPicker } from './TagPicker';
import type { Tag } from '../api/types';
import { tagAc } from '@memex-ai-ac/vitest';

// spec-136 t-6 (ac-1, ac-2). This file is TAGGED (tagAc) — it POSTs an AC event
// to PROD memex.ai on completion. Do NOT run it from an automated process; a
// human runs the tagged suite. Verify the implementation with `npx tsc --noEmit`,
// the build, and the UNTAGGED suites only.

const fetchMemexTagsMock = vi.fn();
const setDocTagsMock = vi.fn();
const removeDocTagMock = vi.fn();

vi.mock('../api/client', () => ({
  fetchMemexTags: () => fetchMemexTagsMock(),
  setDocTags: (docId: string, tags: string[]) => setDocTagsMock(docId, tags),
  removeDocTag: (docId: string, tagId: string) => removeDocTagMock(docId, tagId),
}));

let nextId = 0;
function tag(over: Partial<Tag> = {}): Tag {
  return {
    id: `tag-${nextId++}`,
    memexId: 'mx-1',
    scope: null,
    value: 'bug',
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  nextId = 0;
  fetchMemexTagsMock.mockResolvedValue([]);
});

describe('TagPicker — ac-1 (assign via pick or inline-create, no admin gate)', () => {
  it('renders an add affordance for any viewer — no role gate', () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-136/acs/ac-1');

    render(<TagPicker docId="doc-1" tags={[]} />);

    // The control is present unconditionally — there is no admin/permission prop
    // and no gate; anyone who can see the Spec can open the picker.
    expect(screen.getByTestId('tag-picker-add')).toBeInTheDocument();
  });

  it('picks an existing catalogue tag and applies it', async () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-136/acs/ac-1');
    const user = userEvent.setup();

    const existing = tag({ scope: 'area', value: 'auth' });
    fetchMemexTagsMock.mockResolvedValue([existing]);
    setDocTagsMock.mockResolvedValue({ applied: [existing], tags: [existing] });

    const onTagsChange = vi.fn();
    render(<TagPicker docId="doc-1" tags={[]} onTagsChange={onTagsChange} />);

    await user.click(screen.getByTestId('tag-picker-add'));

    // The catalogue loads and the existing tag shows as a pickable option.
    const option = await screen.findByTestId('tag-picker-option');
    await user.click(option);

    await waitFor(() => {
      expect(setDocTagsMock).toHaveBeenCalledWith('doc-1', ['area::auth']);
    });
    expect(onTagsChange).toHaveBeenCalledWith([existing]);
  });

  it('creates a brand-new tag inline from typed text when nothing matches', async () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-136/acs/ac-1');
    const user = userEvent.setup();

    fetchMemexTagsMock.mockResolvedValue([]); // empty catalogue → no matches
    const coined = tag({ scope: null, value: 'flaky' });
    setDocTagsMock.mockResolvedValue({ applied: [coined], tags: [coined] });

    const onTagsChange = vi.fn();
    render(<TagPicker docId="doc-1" tags={[]} onTagsChange={onTagsChange} />);

    await user.click(screen.getByTestId('tag-picker-add'));
    const input = await screen.findByTestId('tag-picker-input');
    await user.type(input, 'flaky');

    // No catalogue match → an inline "Create" affordance appears.
    const create = await screen.findByTestId('tag-picker-create');
    await user.click(create);

    await waitFor(() => {
      expect(setDocTagsMock).toHaveBeenCalledWith('doc-1', ['flaky']);
    });
    expect(onTagsChange).toHaveBeenCalledWith([coined]);
  });

  it('removes a tag from the Spec with one click', async () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-136/acs/ac-1');
    const user = userEvent.setup();

    const applied = tag({ scope: null, value: 'bug' });
    removeDocTagMock.mockResolvedValue({ tags: [] });

    const onTagsChange = vi.fn();
    render(<TagPicker docId="doc-1" tags={[applied]} onTagsChange={onTagsChange} />);

    await user.click(screen.getByTestId('tag-chip-remove'));

    await waitFor(() => {
      expect(removeDocTagMock).toHaveBeenCalledWith('doc-1', applied.id);
    });
    expect(onTagsChange).toHaveBeenCalledWith([]);
  });
});

describe('TagPicker — ac-2 (scoped swap; flat tags multi-valued)', () => {
  it('reflects per-scope mutual exclusivity: applying priority::high swaps out priority::low', async () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-136/acs/ac-2');
    const user = userEvent.setup();

    const low = tag({ scope: 'priority', value: 'low' });
    const high = tag({ scope: 'priority', value: 'high' });
    fetchMemexTagsMock.mockResolvedValue([low, high]);
    // Server enforces mutual exclusivity: result has high but NOT low.
    setDocTagsMock.mockResolvedValue({ applied: [high], tags: [high] });

    const onTagsChange = vi.fn();
    render(<TagPicker docId="doc-1" tags={[low]} onTagsChange={onTagsChange} />);

    // `priority::low` is already applied, so it should not appear as an option.
    await user.click(screen.getByTestId('tag-picker-add'));
    const input = await screen.findByTestId('tag-picker-input');
    await user.type(input, 'priority::high');

    // The catalogue has priority::high (not yet applied) — pick it.
    const option = await screen.findByTestId('tag-picker-option');
    await user.click(option);

    await waitFor(() => {
      expect(setDocTagsMock).toHaveBeenCalledWith('doc-1', ['priority::high']);
    });
    // UI reflects the swap: the doc now carries high, not low.
    expect(onTagsChange).toHaveBeenCalledWith([high]);
  });

  it('keeps flat tags multi-valued: a second flat tag stacks rather than replacing', async () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-136/acs/ac-2');
    const user = userEvent.setup();

    const bug = tag({ scope: null, value: 'bug' });
    const flaky = tag({ scope: null, value: 'flaky' });
    fetchMemexTagsMock.mockResolvedValue([bug, flaky]);
    // Flat tags are additive — the server returns BOTH.
    setDocTagsMock.mockResolvedValue({ applied: [flaky], tags: [bug, flaky] });

    const onTagsChange = vi.fn();
    render(<TagPicker docId="doc-1" tags={[bug]} onTagsChange={onTagsChange} />);

    await user.click(screen.getByTestId('tag-picker-add'));
    // `bug` is applied; only `flaky` is offered.
    const option = await screen.findByTestId('tag-picker-option');
    await user.click(option);

    await waitFor(() => {
      expect(setDocTagsMock).toHaveBeenCalledWith('doc-1', ['flaky']);
    });
    expect(onTagsChange).toHaveBeenCalledWith([bug, flaky]);
  });
});
