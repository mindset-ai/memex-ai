import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { alignSections, summarizeSectionDiff } from './diffSections';
import type { DocSection } from '../api/types';

// spec-448 ac-6: from the version switcher, a user can visually diff two
// versions of a Spec's narrative; the diff summarises changed sections
// (added / removed / changed / moved) by their stable section identity,
// reading the full-fidelity snapshots.
const AC_ALIGN = 'mindset-prod/memex-building-itself/specs/spec-448/acs/ac-6';

function section(overrides: Partial<DocSection> & { seq: number }): DocSection {
  return {
    id: `sec-${overrides.seq}`,
    sectionType: 'overview',
    title: null,
    content: 'content',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('alignSections', () => {
  it('classifies a seq present only in the new snapshot as added', () => {
    tagAc(AC_ALIGN);
    const oldSections = [section({ seq: 1, content: 'A' })];
    const newSections = [section({ seq: 1, content: 'A' }), section({ seq: 2, content: 'B' })];
    const entries = alignSections(oldSections, newSections);
    const added = entries.find((e) => e.seq === 2);
    expect(added).toBeDefined();
    expect(added!.status).toBe('added');
    expect(added!.moved).toBe(false);
    expect(added!.oldSection).toBeNull();
    expect(added!.newSection).toEqual(newSections[1]);
  });

  it('classifies a seq present only in the old snapshot as removed', () => {
    tagAc(AC_ALIGN);
    const oldSections = [section({ seq: 1, content: 'A' }), section({ seq: 2, content: 'B' })];
    const newSections = [section({ seq: 1, content: 'A' })];
    const entries = alignSections(oldSections, newSections);
    const removed = entries.find((e) => e.seq === 2);
    expect(removed).toBeDefined();
    expect(removed!.status).toBe('removed');
    expect(removed!.newSection).toBeNull();
    expect(removed!.oldSection).toEqual(oldSections[1]);
  });

  it('classifies a seq in both with different content as changed', () => {
    tagAc(AC_ALIGN);
    const oldSections = [section({ seq: 1, content: 'old text' })];
    const newSections = [section({ seq: 1, content: 'new text' })];
    const entries = alignSections(oldSections, newSections);
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe('changed');
    expect(entries[0].moved).toBe(false);
  });

  it('classifies a seq in both with the same content and same position as unchanged', () => {
    tagAc(AC_ALIGN);
    const oldSections = [section({ seq: 1, content: 'same' }), section({ seq: 2, content: 'B' })];
    const newSections = [section({ seq: 1, content: 'same' }), section({ seq: 2, content: 'B' })];
    const entries = alignSections(oldSections, newSections);
    const first = entries.find((e) => e.seq === 1)!;
    expect(first.status).toBe('unchanged');
    expect(first.moved).toBe(false);
  });

  it('classifies a seq in both with identical content but a different position as moved', () => {
    tagAc(AC_ALIGN);
    const oldSections = [section({ seq: 1, content: 'A' }), section({ seq: 2, content: 'B' })];
    const newSections = [section({ seq: 2, content: 'B' }), section({ seq: 1, content: 'A' })];
    const entries = alignSections(oldSections, newSections);
    const moved = entries.find((e) => e.seq === 1)!;
    expect(moved.status).toBe('moved');
    expect(moved.moved).toBe(true);
  });

  it('a section that is both edited AND reordered reports status "changed" with moved=true', () => {
    tagAc(AC_ALIGN);
    const oldSections = [section({ seq: 1, content: 'A' }), section({ seq: 2, content: 'B' })];
    const newSections = [section({ seq: 2, content: 'B' }), section({ seq: 1, content: 'A-edited' })];
    const entries = alignSections(oldSections, newSections);
    const entry = entries.find((e) => e.seq === 1)!;
    expect(entry.status).toBe('changed');
    expect(entry.moved).toBe(true);
  });

  it('a title-only change (identical content) is still classified as changed', () => {
    tagAc(AC_ALIGN);
    const oldSections = [section({ seq: 1, content: 'same', title: 'Old Title' })];
    const newSections = [section({ seq: 1, content: 'same', title: 'New Title' })];
    const entries = alignSections(oldSections, newSections);
    expect(entries[0].status).toBe('changed');
  });

  it('orders entries by their position in the new snapshot, with pure removals trailing', () => {
    tagAc(AC_ALIGN);
    const oldSections = [
      section({ seq: 1, content: 'A' }),
      section({ seq: 2, content: 'B' }),
      section({ seq: 3, content: 'C' }),
    ];
    const newSections = [
      section({ seq: 3, content: 'C' }),
      section({ seq: 1, content: 'A' }),
    ];
    const entries = alignSections(oldSections, newSections);
    // seq 3 is first in `to`, seq 1 is second, seq 2 was removed (trails).
    expect(entries.map((e) => e.seq)).toEqual([3, 1, 2]);
  });

  it('handles two empty snapshots without error', () => {
    tagAc(AC_ALIGN);
    expect(alignSections([], [])).toEqual([]);
  });
});

describe('summarizeSectionDiff', () => {
  it('tallies each status bucket', () => {
    tagAc(AC_ALIGN);
    const oldSections = [
      section({ seq: 1, content: 'same' }),
      section({ seq: 2, content: 'old' }),
      section({ seq: 3, content: 'gone' }),
    ];
    const newSections = [
      section({ seq: 1, content: 'same' }),
      section({ seq: 2, content: 'new' }),
      section({ seq: 4, content: 'fresh' }),
    ];
    const summary = summarizeSectionDiff(alignSections(oldSections, newSections));
    expect(summary).toEqual({ added: 1, removed: 1, changed: 1, moved: 0, unchanged: 1 });
  });
});
