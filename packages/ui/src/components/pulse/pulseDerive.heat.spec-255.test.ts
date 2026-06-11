import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import {
  rankHotSpecs,
  specState,
  quietLabel,
  type HotState,
} from './pulseDerive';
import type { ActivityRow, ActorKind, PresentRow } from './types';

// spec-255 — Hot Specs heat ranking + state. Pure-function coverage for dec-7
// (ranking + state) and dec-2 (honest floor: "quiet Nm", never "waiting").
const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-255/acs/ac-${n}`;

const NOW = 1_700_000_000_000; // fixed clock so decay math is deterministic
const MIN = 60_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

let seq = 0;
function act(p: Partial<ActivityRow> & Pick<ActivityRow, 'briefId'>): ActivityRow {
  seq += 1;
  return {
    id: `a${seq}`,
    memexId: 'mx',
    briefId: p.briefId,
    actorUserId: p.actorUserId ?? 'u1',
    actorName: p.actorName ?? null,
    actorKind: p.actorKind ?? 'human',
    channel: p.channel ?? 'rest_ui',
    clientId: p.clientId ?? null,
    entity: p.entity ?? 'task',
    action: p.action ?? 'updated', // state-changing by default
    narrative: p.narrative ?? 'did a thing',
    payload: p.payload ?? null,
    createdAt: p.createdAt ?? ago(0),
  };
}
function present(docId: string, actorKind: ActorKind = 'mcp_agent', clientId = 'c'): PresentRow {
  return {
    memexId: 'mx',
    docId,
    actorUserId: `u-${docId}`,
    actorName: null,
    actorKind,
    channel: actorKind === 'human' ? 'rest_ui' : 'mcp',
    clientId,
    lastSeenAt: new Date(NOW).toISOString(),
    source: actorKind === 'human' ? 'heartbeat' : 'floor',
  };
}

describe('Hot Specs heat (spec-255)', () => {
  it('ranks presence-first then by decayed tempo, capped at top 5', () => {
    tagAc(AC(15));
    const activity: ActivityRow[] = [
      // doc-A: present + 3 recent events (busiest of the present pair)
      act({ briefId: 'doc-A', createdAt: ago(10_000) }),
      act({ briefId: 'doc-A', createdAt: ago(40_000) }),
      act({ briefId: 'doc-A', createdAt: ago(70_000) }),
      // doc-B: present + 1 older event
      act({ briefId: 'doc-B', createdAt: ago(2 * MIN) }),
      // doc-C: no presence, very busy recently → top non-present
      act({ briefId: 'doc-C', createdAt: ago(20_000) }),
      act({ briefId: 'doc-C', createdAt: ago(25_000) }),
      act({ briefId: 'doc-C', createdAt: ago(30_000) }),
      act({ briefId: 'doc-C', createdAt: ago(35_000) }),
      // doc-D / doc-E / doc-F: progressively older single events
      act({ briefId: 'doc-D', createdAt: ago(1 * MIN) }),
      act({ briefId: 'doc-E', createdAt: ago(3 * MIN) }),
      act({ briefId: 'doc-F', createdAt: ago(8 * MIN) }),
      // doc-G: 12min old, no presence → OUT of the ~10min band
      act({ briefId: 'doc-G', createdAt: ago(12 * MIN) }),
    ];
    const present_ = [present('doc-A', 'mcp_agent'), present('doc-B', 'human', 'c2')];

    const ranked = rankHotSpecs(present_, activity, { now: NOW });

    expect(ranked.map((s) => s.docId)).toEqual(['doc-A', 'doc-B', 'doc-C', 'doc-D', 'doc-E']);
    expect(ranked.length).toBe(5); // doc-F drops on the top-5 cap, doc-G is out of band
    expect(ranked[0].hasPresence).toBe(true);
    expect(ranked[1].hasPresence).toBe(true);
    expect(ranked[2].hasPresence).toBe(false);
  });

  it('classifies each spec into exactly one of hot | cooling | quiet', () => {
    tagAc(AC(16));
    expect(specState(true, 9 * MIN)).toBe('hot'); // presence overrides age
    expect(specState(false, 30_000)).toBe('hot'); // activity < 60s
    expect(specState(false, 3 * MIN)).toBe('cooling'); // 60s..5min
    expect(specState(false, 7 * MIN)).toBe('quiet'); // > 5min
  });

  it('renders the honest-floor quiet label "quiet Nm"', () => {
    tagAc(AC(12));
    expect(quietLabel(6 * MIN + 5_000)).toBe('quiet 6m');
    expect(quietLabel(1 * MIN)).toBe('quiet 1m');
    expect(quietLabel(30_000)).toBe('quiet 1m'); // floors to >= 1
  });

  it('never produces a "waiting"/"awaiting" state or label', () => {
    tagAc(AC(13));
    const valid: HotState[] = ['hot', 'cooling', 'quiet'];
    for (const s of [
      specState(true, null),
      specState(false, 30_000),
      specState(false, 3 * MIN),
      specState(false, 7 * MIN),
    ]) {
      expect(valid).toContain(s);
    }
    for (const ms of [1 * MIN, 6 * MIN, 20 * MIN]) {
      expect(quietLabel(ms)).toMatch(/^quiet \d+m$/);
      expect(quietLabel(ms)).not.toMatch(/wait/i);
    }
    const ranked = rankHotSpecs(
      [present('doc-X')],
      [act({ briefId: 'doc-X', createdAt: ago(7 * MIN) })],
      { now: NOW },
    );
    for (const s of ranked) expect(valid).toContain(s.state);
  });
});
