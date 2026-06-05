// b-68 t-2: tests for the BASE scaffold dataset.
//
// These tests assert the structural integrity of `BASE_SCAFFOLD` — that every
// PhaseNode references real PromptBlockNodes, every forward transition has
// exactly one rubric, every manifest tool has a ToolNode, every base
// GuidanceBlock is enabled + `source:'base'`, and no record mixes target
// dimensions in a way that would be a category error (gate vs nudge).

import { describe, it, expect } from 'vitest';
import { tagAc } from "@memex-ai-ac/vitest";
import { BASE_SCAFFOLD } from './scaffold-data.js';
import { toolManifest } from './tool-manifest.js';

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-68/acs/ac-${n}`;

describe('BASE_SCAFFOLD — structural integrity', () => {
  it('contains exactly the five lifecycle phases', () => {
    tagAc(AC(15));

    const phaseNames = BASE_SCAFFOLD.phases.map((p) => p.phase).sort();
    expect(phaseNames).toEqual(['build', 'done', 'draft', 'plan', 'verify']);
  });

  it('every base ScaffoldNode carries a non-empty rationale', () => {
    tagAc(AC(15));

    // ac-15 + ac-14 invariant: rationale is structural on every node kind.
    for (const phase of BASE_SCAFFOLD.phases) {
      expect(phase.rationale.trim().length).toBeGreaterThan(0);
    }
    for (const block of BASE_SCAFFOLD.promptBlocks) {
      expect(block.rationale.trim().length).toBeGreaterThan(0);
    }
    for (const tool of BASE_SCAFFOLD.tools) {
      expect(tool.rationale.trim().length).toBeGreaterThan(0);
    }
    for (const transition of BASE_SCAFFOLD.transitions) {
      expect(transition.rationale.trim().length).toBeGreaterThan(0);
    }
    for (const guidance of BASE_SCAFFOLD.baseGuidance) {
      expect(guidance.rationale.trim().length).toBeGreaterThan(0);
    }
  });

  it('every PhaseNode.promptBlockIds reference resolves to a real PromptBlockNode', () => {
    tagAc(AC(15));

    const blockIds = new Set(BASE_SCAFFOLD.promptBlocks.map((b) => b.id));
    for (const phase of BASE_SCAFFOLD.phases) {
      for (const id of phase.promptBlockIds) {
        expect(blockIds.has(id), `phase ${phase.phase} references missing prompt block "${id}"`).toBe(true);
      }
    }
  });

  it('every PhaseNode.promptBlockIds references only react_only PromptBlockNodes (per b-68 dec-9)', () => {
    // Per b-68 dec-9: about-spec, mutation-protocol, code-grounding,
    // standards-protocol are shared_nudge, NOT in promptBlockIds. Verify.
    const byId = new Map(BASE_SCAFFOLD.promptBlocks.map((b) => [b.id, b]));
    for (const phase of BASE_SCAFFOLD.phases) {
      for (const id of phase.promptBlockIds) {
        const block = byId.get(id);
        expect(block?.surface).toBe('react_only');
      }
    }
  });
});

describe('BASE_SCAFFOLD.transitions — one rubric per forward transition (ac-32)', () => {
  it('contains exactly the four forward transitions plan | build | verify | done', () => {
    tagAc(AC(32));

    const transitions = BASE_SCAFFOLD.transitions.map((t) => t.transition).sort();
    expect(transitions).toEqual(['build', 'done', 'plan', 'verify']);
    expect(BASE_SCAFFOLD.transitions).toHaveLength(4);
  });

  it('every TransitionRubric carries non-empty rubric prose', () => {
    tagAc(AC(32));

    for (const t of BASE_SCAFFOLD.transitions) {
      expect(t.text.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('BASE_SCAFFOLD.tools — parity with tool-manifest', () => {
  it('contains the same count as toolManifest', () => {
    expect(BASE_SCAFFOLD.tools).toHaveLength(toolManifest.length);
  });

  it('every tool name in the manifest appears in the ToolNode set', () => {
    const toolNames = new Set(BASE_SCAFFOLD.tools.map((t) => t.name));
    for (const entry of toolManifest) {
      expect(toolNames.has(entry.name), `manifest tool "${entry.name}" missing from BASE_SCAFFOLD.tools`).toBe(true);
    }
  });

  it('every ToolNode preserves the manifest shape (name, summary, args, group)', () => {
    const manifestByName = new Map(toolManifest.map((e) => [e.name, e]));
    for (const tool of BASE_SCAFFOLD.tools) {
      const entry = manifestByName.get(tool.name);
      expect(entry).toBeDefined();
      expect(tool.summary).toBe(entry!.summary);
      expect(tool.args).toBe(entry!.args);
      expect(tool.group).toBe(entry!.group);
    }
  });
});

describe('BASE_SCAFFOLD.baseGuidance — source + enabled invariants', () => {
  it('every base GuidanceBlock has source="base"', () => {
    for (const block of BASE_SCAFFOLD.baseGuidance) {
      expect(block.source).toBe('base');
    }
  });

  it('every base GuidanceBlock has enabled=true', () => {
    for (const block of BASE_SCAFFOLD.baseGuidance) {
      expect(block.enabled).toBe(true);
    }
  });

  it('no base GuidanceBlock carries Org-only metadata (orgId, authorId, createdAt, updatedAt)', () => {
    for (const block of BASE_SCAFFOLD.baseGuidance) {
      expect(block.orgId).toBeUndefined();
      expect(block.authorId).toBeUndefined();
      expect(block.createdAt).toBeUndefined();
      expect(block.updatedAt).toBeUndefined();
    }
  });
});

describe('BASE_SCAFFOLD.baseGuidance — target category integrity', () => {
  it('no base GuidanceBlock mixes target.transition with target.phase or target.tool', () => {
    // Transition blocks are pure gate content — they ride toRubric, not
    // toNudge. Mixing transition + phase/tool on a SINGLE record is a
    // category error: the projection contract treats them as separate
    // channels. Base records that target a phase or a tool live on the
    // nudge channel only; base records that target a transition live on
    // the rubric channel only.
    for (const block of BASE_SCAFFOLD.baseGuidance) {
      if (block.target.transition !== undefined) {
        expect(block.target.phase).toBeUndefined();
        expect(block.target.tool).toBeUndefined();
      }
    }
  });
});
