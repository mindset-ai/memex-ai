// spec-203 dec-1: tests for the footer-handoff-essence projection.
//
// The Spec's headline promise is that the copy button (full `text`) and the
// in-chat footer (compressed `essence`) are two projections of ONE canonical
// handoff node, so they cannot drift. These tests pin that contract:
//   - toHandoffEssence returns the right phase's essence, null for draft/done;
//   - the phase→node map (HANDOFF_BUTTON_BY_PHASE) and the essence field stay
//     bound in BOTH directions (no mapped phase without an essence; no essence
//     node the map can't reach) — the std-15 "one home" guarantee in test form;
//   - text and essence physically co-habit one node for every handoff phase.

import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import {
  toHandoffEssence,
  HANDOFF_BUTTON_BY_PHASE,
  type Phase,
} from './scaffold-model.js';
import { BASE_SCAFFOLD } from './scaffold-data.js';

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-203/acs/ac-${n}`;

const FORWARD_PHASES: Phase[] = ['specify', 'build', 'verify'];
const NO_HANDOFF_PHASES: Phase[] = ['draft', 'done'];

describe('toHandoffEssence', () => {
  it('returns the build handoff essence for the build phase', () => {
    tagAc(AC(5));
    const essence = toHandoffEssence(BASE_SCAFFOLD, 'build');
    expect(essence).toContain('You are now in build');
    // The behaviours spec-120 proved never reach a chat agent must be present.
    expect(essence).toContain('break the work into tasks');
    expect(essence).toContain("update_doc({status:'verify'})");
  });

  it('returns the specify handoff essence for the specify phase', () => {
    const essence = toHandoffEssence(BASE_SCAFFOLD, 'specify');
    expect(essence).toContain('You are now in specify');
    expect(essence).toContain('create_decision');
    expect(essence).toContain('scope acceptance criteria');
  });

  it('returns the verify handoff essence for the verify phase', () => {
    const essence = toHandoffEssence(BASE_SCAFFOLD, 'verify');
    expect(essence).toContain('You are now in verify');
    expect(essence).toContain('all six dimensions');
  });

  it.each(NO_HANDOFF_PHASES)('returns null for the %s phase (no handoff)', (phase) => {
    tagAc(AC(5));
    expect(toHandoffEssence(BASE_SCAFFOLD, phase)).toBeNull();
  });

  it('returns null when the mapped node carries no essence', () => {
    // A dataset whose handoff node has had its essence stripped must degrade to
    // null, never to an empty/whitespace string in the footer.
    const stripped = {
      ...BASE_SCAFFOLD,
      promptButtons: BASE_SCAFFOLD.promptButtons.map((b) =>
        b.id === HANDOFF_BUTTON_BY_PHASE.build ? { ...b, essence: '   ' } : b,
      ),
    };
    expect(toHandoffEssence(stripped, 'build')).toBeNull();
  });
});

describe('handoff essence ↔ phase-map parity (spec-203 dec-1, std-15)', () => {
  it('every phase the map names resolves to an existing node WITH an essence', () => {
    tagAc(AC(6));
    for (const phase of FORWARD_PHASES) {
      const buttonId = HANDOFF_BUTTON_BY_PHASE[phase];
      expect(buttonId, `map must name a handoff for ${phase}`).toBeTruthy();
      const node = BASE_SCAFFOLD.promptButtons.find((b) => b.id === buttonId);
      expect(node, `node ${buttonId} must exist`).toBeDefined();
      expect(node?.essence?.trim(), `node ${buttonId} must carry an essence`).toBeTruthy();
    }
  });

  it('every node that carries an essence is reachable from the phase map (no orphans)', () => {
    tagAc(AC(6));
    const reachable = new Set(Object.values(HANDOFF_BUTTON_BY_PHASE));
    const essenceNodes = BASE_SCAFFOLD.promptButtons.filter((b) => b.essence?.trim());
    for (const node of essenceNodes) {
      expect(
        reachable.has(node.id),
        `node ${node.id} has an essence but no phase maps to it — orphaned footer prose`,
      ).toBe(true);
    }
  });

  it('text and essence co-habit one node for every handoff phase (cannot drift)', () => {
    tagAc(AC(6));
    // Scope outcome: footer and copy button are one canonical source that
    // cannot silently diverge (ac-2).
    tagAc(AC(2));
    for (const phase of FORWARD_PHASES) {
      const node = BASE_SCAFFOLD.promptButtons.find(
        (b) => b.id === HANDOFF_BUTTON_BY_PHASE[phase],
      );
      // The full copy-button prompt and the footer essence are fields on the
      // SAME object — the structural form of the "one canonical source" promise.
      expect(node?.text?.length, `${phase} node must have full text`).toBeGreaterThan(0);
      expect(node?.essence?.length, `${phase} node must have essence`).toBeGreaterThan(0);
    }
  });

  it('draft and done are absent from the map (encodes "no handoff line")', () => {
    for (const phase of NO_HANDOFF_PHASES) {
      expect(HANDOFF_BUTTON_BY_PHASE[phase]).toBeUndefined();
    }
  });
});
