// spec-196 t-3 — the dec-3 consolidation copy, pinned at its live homes.
//
// dec-1: human-facing strings say "spec narrative"; internal vocabulary keeps
// "narrative" (node ids, field names, the assess_spec mode). dec-3 set the two
// approved strings. The LIVE home of the refresh prompt is the scaffold's
// `opening-refresh-narrative` opening-turn helper (spec-123) — the top-bar
// RefreshSpecButton is unmounted and merely kept in sync.
//
//   ac-2  : every human-facing prompt string says "spec narrative"; the old
//           phrasings are gone.
//   ac-7  : no internal rename — node id, field names, exports unchanged.
//   ac-11 : the refresh prompt equals the dec-3 string exactly.

import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { BASE_SCAFFOLD } from './scaffold-data';
import {
  computeSpecReadiness,
  isSpecNarrativeStale,
  countStaleDecisions,
} from './spec-readiness';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-196/acs/ac-${n}`;

const DEC3_PROMPT =
  'Update the spec narrative — walk every decision modified since the last consolidation and update the affected sections so the narrative reflects what was decided.';

function refreshNode() {
  const node = BASE_SCAFFOLD.promptButtons.find((b) => b.id === 'opening-refresh-narrative');
  if (!node) throw new Error('opening-refresh-narrative node missing from BASE_SCAFFOLD');
  return node;
}

describe('spec-196 t-3 — consolidation copy (dec-3)', () => {
  it('the opening-turn refresh helper carries the exact dec-3 prompt and the "spec narrative" label (ac-2, ac-11)', () => {
    tagAc(AC(2));
    tagAc(AC(11));
    const node = refreshNode();
    expect(node.text).toBe(DEC3_PROMPT);
    expect(node.label).toBe('Update spec narrative');
  });

  it('the stale-narrative CTA points at the live helper in "spec narrative" terms (ac-2)', () => {
    tagAc(AC(2));
    const r = computeSpecReadiness({
      currentPhase: 'specify',
      decisions: [
        {
          id: 'd-1',
          createdAt: '2026-06-01T00:00:00Z',
          resolvedAt: '2026-06-05T00:00:00Z',
          status: 'resolved',
        },
      ],
      openCommentCount: 0,
      narrativeLastConsolidatedAt: '2026-06-02T00:00:00Z',
    });
    const stale = r.outstandingItems.find((i) => i.kind === 'stale_narrative');
    expect(stale?.cta).toBe('Use the "Update spec narrative" helper to consolidate.');
  });

  it('the retired phrasings are gone from every prompt-button string (ac-2)', () => {
    tagAc(AC(2));
    for (const b of BASE_SCAFFOLD.promptButtons) {
      expect(b.text).not.toMatch(/Refresh the Spec narrative/i);
      expect(b.label).not.toMatch(/^Update narrative$/i);
    }
  });

  it('no internal rename: node id and shared staleness exports keep the word "narrative" (ac-7)', () => {
    tagAc(AC(7));
    // The node id is internal vocabulary — dec-1 keeps it.
    expect(refreshNode().id).toBe('opening-refresh-narrative');
    // The shared staleness surface is intact under its original names.
    expect(typeof isSpecNarrativeStale).toBe('function');
    expect(typeof countStaleDecisions).toBe('function');
    expect(
      isSpecNarrativeStale('2026-06-06T00:00:00Z', [
        {
          id: 'd-1',
          createdAt: '2026-06-01T00:00:00Z',
          resolvedAt: '2026-06-05T00:00:00Z',
          status: 'resolved',
        },
      ]),
    ).toBe(false);
  });
});
