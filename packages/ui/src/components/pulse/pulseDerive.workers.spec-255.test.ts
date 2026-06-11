import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { workingNow, involvedOnSpec } from './pulseDerive';
import type { ActivityRow, ActorKind, PresentRow } from './types';

// spec-255 (int feedback) — Working Now + card avatars are driven by presence
// UNIONed with recent activity, retained 5min, freshness-graded — so reading a
// long spec doesn't drop you and a cooling spec still shows who was on it.
const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-255/acs/ac-${n}`;

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function present(docId: string, actorUserId: string, agoMs = 0, actorKind: ActorKind = 'human'): PresentRow {
  return {
    memexId: 'mx',
    docId,
    actorUserId,
    actorName: actorUserId,
    actorKind,
    channel: actorKind === 'human' ? 'rest_ui' : 'mcp',
    clientId: `c-${actorUserId}`,
    lastSeenAt: ago(agoMs),
    source: 'heartbeat',
  };
}
let seq = 0;
function act(docId: string, actorUserId: string, agoMs: number, actorKind: ActorKind = 'human'): ActivityRow {
  seq += 1;
  return {
    id: `a${seq}`,
    memexId: 'mx',
    briefId: docId,
    actorUserId,
    actorName: actorUserId,
    actorKind,
    channel: actorKind === 'human' ? 'rest_ui' : 'mcp',
    clientId: null,
    entity: 'task',
    action: 'updated',
    narrative: 'did a thing',
    payload: null,
    createdAt: ago(agoMs),
  };
}

describe('workingNow (spec-255)', () => {
  it('unions presence + recent activity, retains 5min, grades freshness', () => {
    tagAc(AC(5));
    const workers = workingNow(
      [present('d1', 'u-live', 0)], // live heartbeat
      [
        act('d1', 'u-recent', 1 * MIN), // active 1min ago → live (< 2min)
        act('d2', 'u-idle', 4 * MIN), // 4min ago, no presence → idle (still in band)
        act('d3', 'u-gone', 6 * MIN), // 6min ago → dropped (> 5min)
      ],
      NOW,
    );
    const ids = workers.map((w) => w.actorUserId);
    expect(ids).toContain('u-live');
    expect(ids).toContain('u-recent');
    expect(ids).toContain('u-idle');
    expect(ids).not.toContain('u-gone');

    expect(workers.find((w) => w.actorUserId === 'u-live')!.freshness).toBe('live');
    expect(workers.find((w) => w.actorUserId === 'u-recent')!.freshness).toBe('live');
    expect(workers.find((w) => w.actorUserId === 'u-idle')!.freshness).toBe('idle');
  });

  it('a foreground reader (live heartbeat) stays even with no recent activity', () => {
    tagAc(AC(5));
    // heartbeat 10s ago, but their last activity was 4min ago → still LIVE (present).
    const workers = workingNow([present('d1', 'u-read', 10_000)], [act('d1', 'u-read', 4 * MIN)], NOW);
    expect(workers).toHaveLength(1);
    expect(workers[0].freshness).toBe('live');
  });
});

describe('involvedOnSpec (spec-255)', () => {
  it('shows who was on a cooling spec (no live presence), scoped to that spec', () => {
    tagAc(AC(5));
    const workers = involvedOnSpec([], [act('d1', 'u-1', 3 * MIN)], 'd1', NOW);
    expect(workers.map((w) => w.actorUserId)).toEqual(['u-1']);
    expect(workers[0].freshness).toBe('idle');
    // another spec's activity does not leak in.
    expect(involvedOnSpec([], [act('d2', 'u-2', 1 * MIN)], 'd1', NOW)).toHaveLength(0);
  });
});
