// spec-343 t-8 / ac-8: composition-fidelity guard.
//
// The redesigned surface renders the composed prompt as inline segments. This
// test proves the segment join is BYTE-IDENTICAL to the @memex/shared
// projections (toNudge / toRubric / toButtonPrompt) for every (tool, phase),
// every forward transition, every prompt button, and the org-global band —
// i.e. the redesign changed presentation only, not what the agents receive.

import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import {
  BASE_SCAFFOLD,
  toNudge,
  toRubric,
  toButtonPrompt,
  type GuidanceBlock,
  type Phase,
  type Transition,
} from '@memex/shared';
import {
  buttonSegments,
  globalSegments,
  joinSegments,
  nudgeSegments,
  rubricSegments,
} from './composition';
import type { OrgScaffoldAddition } from '../../api/scaffold';

const AC = 'mindset-prod/memex-building-itself/specs/spec-343/acs/ac-8';

const PHASES: Phase[] = ['draft', 'specify', 'build', 'verify', 'done'];
const TRANSITIONS: Transition[] = ['specify', 'build', 'verify', 'done'];

// A spread of Org additions touching every target shape, so the join guard
// exercises org segments (not just base) on each channel. Mix enabled/disabled
// to prove disabled rows are excluded identically on both sides.
const firstTool = BASE_SCAFFOLD.tools[0]?.name ?? 'update_section';
const firstButton = BASE_SCAFFOLD.promptButtons[0]?.id;

const orgBlocks: OrgScaffoldAddition[] = [
  mkOrg('org-global', { }, 'ORG GLOBAL ADDITION.', true, 0),
  mkOrg('org-phase', { phase: 'build' }, 'ORG BUILD STAGE.', true, 1),
  mkOrg('org-tool-phase', { tool: firstTool, phase: 'build' }, 'ORG TOOL+PHASE NUDGE.', true, 2),
  mkOrg('org-tool', { tool: firstTool }, 'ORG TOOL EVERY PHASE.', true, 3),
  mkOrg('org-disabled', { phase: 'build' }, 'ORG DISABLED — MUST NOT APPEAR.', false, 4),
  mkOrg('org-transition', { transition: 'build' }, 'ORG GATE CHECK.', true, 5),
  ...(firstButton ? [mkOrg('org-button', { button: firstButton }, 'ORG BUTTON APPEND.', true, 6)] : []),
];

function mkOrg(
  id: string,
  target: GuidanceBlock['target'],
  text: string,
  enabled: boolean,
  order: number,
): OrgScaffoldAddition {
  return {
    kind: 'guidance_block',
    source: 'org',
    target,
    text,
    enabled,
    order,
    rationale: `${id} rationale`,
    id,
    orgId: 'org-uuid',
  };
}

describe('composition fidelity — segment join === projection (ac-8)', () => {
  it('nudge segments join to exactly toNudge for every (tool, phase)', () => {
    tagAc(AC);
    // The byte-identity guarantee is exactly scope ac-5: the redesign leaves
    // the prompts the agents receive unchanged.
    tagAc('mindset-prod/memex-building-itself/specs/spec-343/acs/ac-5');
    for (const tool of BASE_SCAFFOLD.tools.map((t) => t.name)) {
      for (const phase of PHASES) {
        const join = joinSegments(nudgeSegments(BASE_SCAFFOLD, tool, phase, orgBlocks));
        const projection = toNudge({ dataset: BASE_SCAFFOLD, tool, phase, orgBlocks });
        expect(join).toBe(projection);
      }
    }
  });

  it('global band segments join to exactly toNudge with no tool/phase (ac-8)', () => {
    tagAc(AC);
    const join = joinSegments(globalSegments(BASE_SCAFFOLD, orgBlocks));
    const projection = toNudge({ dataset: BASE_SCAFFOLD, orgBlocks });
    expect(join).toBe(projection);
  });

  it('rubric segments join to exactly toRubric for every transition (ac-8)', () => {
    tagAc(AC);
    for (const transition of TRANSITIONS) {
      const join = joinSegments(rubricSegments(BASE_SCAFFOLD, transition, orgBlocks));
      const projection = toRubric({ dataset: BASE_SCAFFOLD, transition, orgBlocks });
      expect(join).toBe(projection);
    }
  });

  it('button segments join to exactly toButtonPrompt (empty context) for every button (ac-8)', () => {
    tagAc(AC);
    for (const button of BASE_SCAFFOLD.promptButtons) {
      const join = joinSegments(buttonSegments(BASE_SCAFFOLD, button.id, orgBlocks));
      const projection = toButtonPrompt({
        dataset: BASE_SCAFFOLD,
        buttonId: button.id,
        context: {},
        orgBlocks,
      });
      expect(join).toBe(projection);
    }
  });

  it('disabled Org rows never appear in any composed channel (ac-8)', () => {
    tagAc(AC);
    const buildNudge = joinSegments(nudgeSegments(BASE_SCAFFOLD, firstTool, 'build', orgBlocks));
    expect(buildNudge).not.toContain('MUST NOT APPEAR');
  });
});
