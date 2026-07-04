// spec-448 t-10 (ac-6): align two version snapshots' narrative sections by
// their STABLE `seq` (not array position — sections can be reordered without
// changing identity) and classify each into the switcher's four buckets:
// added / removed / changed / moved. A section can be both `changed` (content
// differs) and `moved` (position differs) at once — `status` picks the more
// salient of the two (content wins), while `moved` is reported independently
// so the overlay can badge it regardless.
//
// This mirrors spec-100's anchorHighlight.ts in spirit (a small pure function
// over data, no DOM/React), so it stays unit-testable in isolation from the
// overlay that consumes it.

import type { DocSection } from '../api/types';

export type SectionDiffStatus = 'added' | 'removed' | 'changed' | 'unchanged' | 'moved';

export interface SectionDiffEntry {
  /** The stable identity both snapshots are aligned on. */
  seq: number;
  /** Primary classification for this section (ac-6's four buckets, plus
   *  'unchanged' for a section identical in content and position). */
  status: SectionDiffStatus;
  /** True when the section's position (index within its snapshot's ordered
   *  sections) differs between `from` and `to`, independent of `status` —
   *  a 'changed' section can also have moved. */
  moved: boolean;
  /** null when the section doesn't exist on that side (added/removed). */
  oldSection: DocSection | null;
  newSection: DocSection | null;
}

/**
 * Align `oldSections` (the `from` snapshot) against `newSections` (the `to`
 * snapshot) by `seq` and classify each into ac-6's buckets. The returned list
 * is ordered by the section's position in the `to` snapshot; a section that
 * only exists in `from` (pure removal) sorts after all `to` sections, in its
 * original `from` order, so removed content still reads in a sensible place
 * relative to the other removals.
 */
export function alignSections(
  oldSections: DocSection[],
  newSections: DocSection[],
): SectionDiffEntry[] {
  const oldBySeq = new Map<number, { section: DocSection; index: number }>();
  oldSections.forEach((section, index) => oldBySeq.set(section.seq, { section, index }));
  const newBySeq = new Map<number, { section: DocSection; index: number }>();
  newSections.forEach((section, index) => newBySeq.set(section.seq, { section, index }));

  const allSeqs = new Set<number>([...oldBySeq.keys(), ...newBySeq.keys()]);
  const entries: SectionDiffEntry[] = [];

  for (const seq of allSeqs) {
    const oldEntry = oldBySeq.get(seq);
    const newEntry = newBySeq.get(seq);

    if (oldEntry && !newEntry) {
      entries.push({
        seq,
        status: 'removed',
        moved: false,
        oldSection: oldEntry.section,
        newSection: null,
      });
      continue;
    }
    if (!oldEntry && newEntry) {
      entries.push({
        seq,
        status: 'added',
        moved: false,
        oldSection: null,
        newSection: newEntry.section,
      });
      continue;
    }
    // seq in both — "candidate-changed": compare content/title/type to decide
    // changed vs unchanged, and index to decide moved, independently.
    if (oldEntry && newEntry) {
      const contentChanged =
        oldEntry.section.content !== newEntry.section.content ||
        oldEntry.section.title !== newEntry.section.title ||
        oldEntry.section.sectionType !== newEntry.section.sectionType;
      const moved = oldEntry.index !== newEntry.index;
      entries.push({
        seq,
        status: contentChanged ? 'changed' : moved ? 'moved' : 'unchanged',
        moved,
        oldSection: oldEntry.section,
        newSection: newEntry.section,
      });
    }
  }

  entries.sort((a, b) => posFor(a, oldBySeq, newBySeq, newSections.length) - posFor(b, oldBySeq, newBySeq, newSections.length));
  return entries;
}

function posFor(
  entry: SectionDiffEntry,
  oldBySeq: Map<number, { section: DocSection; index: number }>,
  newBySeq: Map<number, { section: DocSection; index: number }>,
  newLength: number,
): number {
  const inNew = newBySeq.get(entry.seq);
  if (inNew) return inNew.index;
  // Pure removal — no position in `to`; order after all `to` sections, by its
  // original `from` position.
  const inOld = oldBySeq.get(entry.seq);
  return newLength + (inOld?.index ?? 0);
}

/** Convenience summary counts for a header line ("3 changed, 1 added, …"). */
export interface SectionDiffSummary {
  added: number;
  removed: number;
  changed: number;
  moved: number;
  unchanged: number;
}

export function summarizeSectionDiff(entries: SectionDiffEntry[]): SectionDiffSummary {
  const summary: SectionDiffSummary = { added: 0, removed: 0, changed: 0, moved: 0, unchanged: 0 };
  for (const entry of entries) {
    summary[entry.status] += 1;
  }
  return summary;
}
