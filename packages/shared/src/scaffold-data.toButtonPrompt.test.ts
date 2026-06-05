// spec-103 t-2: tests for the toButtonPrompt projection (Prompt Button, D-7).
//
// Exercises the clipboard-prompt composition contract: base-first ordering,
// enabled-Org-only appends, compose-then-interpolate, rationale exclusion,
// missing-node/null, safe missing-context, and the parity guard that
// button-targeted Org blocks do NOT leak into the agent nudge channel.

import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import {
  toButtonPrompt,
  toNudge,
  type GuidanceBlock,
  type GuidanceTarget,
  type PromptButtonNode,
  type ScaffoldDataset,
} from './scaffold-model.js';
import { BASE_SCAFFOLD } from './scaffold-data.js';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-103/acs/ac-${n}`;

// ── helpers ──────────────────────────────────────────────────────────────

function makeButton(overrides: Partial<PromptButtonNode> = {}): PromptButtonNode {
  return {
    kind: 'prompt_button',
    id: overrides.id ?? 'create-tasks',
    label: overrides.label ?? 'Create Tasks',
    text: overrides.text ?? 'Create tasks for ${specRef}.',
    surfaces: overrides.surfaces ?? ['spec-header'],
    rationale: overrides.rationale ?? 'Hand a plan-phase Spec to an agent.',
  };
}

function makeOrgButtonBlock(overrides: Partial<GuidanceBlock> = {}): GuidanceBlock {
  return {
    kind: 'guidance_block',
    source: 'org',
    target: overrides.target ?? { button: 'create-tasks' },
    text: overrides.text ?? 'ORG: cite the Jira ticket.',
    enabled: overrides.enabled ?? true,
    order: overrides.order ?? 0,
    rationale: overrides.rationale ?? 'Org append for the create-tasks button.',
    orgId: 'org-1',
    authorId: 'user-1',
    createdAt: '2026-06-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
  };
}

function datasetWith(buttons: PromptButtonNode[]): ScaffoldDataset {
  return {
    phases: [],
    promptBlocks: [],
    tools: [],
    transitions: [],
    baseGuidance: [],
    promptButtons: buttons,
  };
}

// ── ac-10: shared model shape ────────────────────────────────────────────

describe('Prompt Button scaffold shape (ac-10)', () => {
  it('exposes the prompt_button kind, promptButtons dataset array, and target.button', () => {
    tagAc(AC(10));

    expect(Array.isArray(BASE_SCAFFOLD.promptButtons)).toBe(true);

    const node = makeButton();
    expect(node.kind).toBe('prompt_button');

    const target: GuidanceTarget = { button: 'create-tasks' };
    expect(target.button).toBe('create-tasks');
  });
});

// ── ac-11: composition contract ──────────────────────────────────────────

describe('toButtonPrompt composition (ac-11)', () => {
  it('composes base first, then enabled Org appends ordered by `order`', () => {
    tagAc(AC(11));

    const dataset = datasetWith([makeButton({ id: 'b', text: 'BASE' })]);
    const org: GuidanceBlock[] = [
      makeOrgButtonBlock({ target: { button: 'b' }, text: 'ORG-2', order: 2 }),
      makeOrgButtonBlock({ target: { button: 'b' }, text: 'ORG-1', order: 1 }),
    ];

    const out = toButtonPrompt({ dataset, buttonId: 'b', context: {}, orgBlocks: org });
    expect(out).toBe('BASE\n\nORG-1\n\nORG-2');
  });

  it('excludes disabled Org blocks and blocks targeting a different button', () => {
    tagAc(AC(11));

    const dataset = datasetWith([makeButton({ id: 'b', text: 'BASE' })]);
    const org: GuidanceBlock[] = [
      makeOrgButtonBlock({ target: { button: 'b' }, text: 'ENABLED', enabled: true, order: 0 }),
      makeOrgButtonBlock({ target: { button: 'b' }, text: 'DISABLED', enabled: false, order: 1 }),
      makeOrgButtonBlock({ target: { button: 'other' }, text: 'OTHER', order: 2 }),
    ];

    const out = toButtonPrompt({ dataset, buttonId: 'b', context: {}, orgBlocks: org });
    expect(out).toBe('BASE\n\nENABLED');
  });

  it('interpolates AFTER composition so Org appends can use ${context} placeholders', () => {
    tagAc(AC(11));

    const dataset = datasetWith([makeButton({ id: 'b', text: 'Base for ${who}.' })]);
    const org: GuidanceBlock[] = [
      makeOrgButtonBlock({ target: { button: 'b' }, text: 'Org note for ${who}.' }),
    ];

    const out = toButtonPrompt({ dataset, buttonId: 'b', context: { who: 'Mindset' }, orgBlocks: org });
    expect(out).toBe('Base for Mindset.\n\nOrg note for Mindset.');
  });

  it('never includes node or block rationale', () => {
    tagAc(AC(11));

    const dataset = datasetWith([makeButton({ id: 'b', text: 'BODY', rationale: 'SECRET-RATIONALE' })]);
    const org: GuidanceBlock[] = [
      makeOrgButtonBlock({ target: { button: 'b' }, text: 'APPEND', rationale: 'ORG-SECRET' }),
    ];

    const out = toButtonPrompt({ dataset, buttonId: 'b', context: {}, orgBlocks: org }) ?? '';
    expect(out).not.toContain('SECRET-RATIONALE');
    expect(out).not.toContain('ORG-SECRET');
  });

  it('button-targeted Org blocks ride toButtonPrompt, not toNudge (parity guard)', () => {
    tagAc(AC(11));

    const dataset = datasetWith([makeButton({ id: 'b', text: 'BASE' })]);
    const org: GuidanceBlock[] = [makeOrgButtonBlock({ target: { button: 'b' }, text: 'BTN-ONLY' })];

    // Picked up by the button projection...
    expect(toButtonPrompt({ dataset, buttonId: 'b', context: {}, orgBlocks: org })).toContain('BTN-ONLY');

    // ...and NOT leaked into the agent nudge channel (button-only target, phase/tool absent).
    const nudge = toNudge({ dataset, tool: 'create_task', phase: 'build', orgBlocks: org });
    expect(nudge).not.toContain('BTN-ONLY');
  });
});

// ── single-brace placeholders + the shipped verify-spec button ───────────

describe('toButtonPrompt placeholder syntax + shipped buttons (ac-11)', () => {
  it('interpolates single-brace {placeholders}, not only ${...}', () => {
    tagAc(AC(11));

    const dataset = datasetWith([makeButton({ id: 'b', text: 'Hi {name}, see {url}.' })]);
    const out = toButtonPrompt({ dataset, buttonId: 'b', context: { name: 'Ada', url: 'https://x' } });
    expect(out).toBe('Hi Ada, see https://x.');
  });

  it('renders the shipped verify-spec button with every placeholder filled', () => {
    tagAc(AC(11));

    const out =
      toButtonPrompt({
        dataset: BASE_SCAFFOLD,
        buttonId: 'verify-spec',
        context: { namespace: 'ns', memex: 'mx', handle: 'spec-9', title: 'T', url: 'https://u' },
      }) ?? '';

    expect(out).toContain('You are working in Memex (ns/mx)');
    expect(out).toContain('Spec spec-9 "T"');
    expect(out).toContain("ref: 'ns/mx/specs/spec-9'");
    // no token left unfilled
    expect(out).not.toMatch(/\{(?:namespace|memex|handle|title|url)\}/);
  });

  // spec-159 ac-17: the new plan-phase handoff node — instructs a coding agent
  // to study the Spec and create Decisions + scope ACs, same `{token}` slots as
  // the build/verify nodes.
  it('renders the shipped plan-handoff button: Decisions + scope ACs, every placeholder filled', () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-159/acs/ac-17');

    const node = BASE_SCAFFOLD.promptButtons.find((b) => b.id === 'plan-handoff');
    expect(node).toBeTruthy();
    expect(node!.surfaces).toContain('spec-header');

    const out =
      toButtonPrompt({
        dataset: BASE_SCAFFOLD,
        buttonId: 'plan-handoff',
        context: { namespace: 'ns', memex: 'mx', handle: 'spec-9', title: 'T', url: 'https://u' },
      }) ?? '';

    expect(out).toContain('You are working in Memex (ns/mx)');
    expect(out).toContain('Spec spec-9 "T"');
    expect(out).toContain('Status: plan');
    expect(out).toContain("ref: 'ns/mx/specs/spec-9'");
    // It directs the agent to surface/resolve Decisions and author scope ACs.
    expect(out).toMatch(/create_decision/);
    expect(out).toMatch(/kind: 'scope'/);
    // It must NOT push the agent into building / creating tasks (that's `build`).
    expect(out).toMatch(/do NOT write product code|create tasks/i);
    // no token left unfilled
    expect(out).not.toMatch(/\{(?:namespace|memex|handle|title|url)\}/);
  });

  // spec-159 ac-17: the plan-handoff node makes per-decision grounding MANDATORY
  // — before discussing each surfaced Decision the agent must search the Memex's
  // history along BOTH axes (prior decisions AND coding standards), once per
  // decision. This is the load-bearing instruction that stops a team from
  // contradicting itself; pin its exact shape so a copy-edit can't quietly drop it.
  it('plan-handoff mandates per-decision grounding against prior decisions AND standards', () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-159/acs/ac-17');

    const out =
      toButtonPrompt({
        dataset: BASE_SCAFFOLD,
        buttonId: 'plan-handoff',
        context: { namespace: 'ns', memex: 'mx', handle: 'spec-9', title: 'T', url: 'https://u' },
      }) ?? '';

    // The grounding is keyed PER DECISION and explicitly once-per-decision /
    // mandatory — not a single Spec-level sweep.
    expect(out).toMatch(/PER DECISION/);
    expect(out).toMatch(/once per decision/i);
    // Both search axes are spelled out as search_memex calls with the two kinds.
    expect(out).toMatch(/search_memex\(\{ query:[^}]*kind: 'decision' \}\)/);
    expect(out).toMatch(/search_memex\(\{ query:[^}]*kind: 'standard' \}\)/);
    // Each search is scoped to the decision's own topic, not a generic query.
    expect(out).toContain("query: '<this decision's topic>'");
  });

  // spec-159 ac-19: the reviewer handoff node — instructs a coding agent to
  // ASK the user which lens(es) to review through (never assuming all four),
  // ABSORB the Spec, review through the chosen lens(es), ground claims against
  // the code, and capture findings as review comments / Issues — never
  // mutating the Spec's shape. Same `{token}` slots as the plan node.
  it('renders the shipped review-handoff button: review lenses + capture, every placeholder filled', () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-159/acs/ac-19');

    const node = BASE_SCAFFOLD.promptButtons.find((b) => b.id === 'review-handoff');
    expect(node).toBeTruthy();
    expect(node!.label).toBe('Review handoff');
    expect(node!.surfaces).toContain('spec-header');

    const out =
      toButtonPrompt({
        dataset: BASE_SCAFFOLD,
        buttonId: 'review-handoff',
        context: { namespace: 'ns', memex: 'mx', handle: 'spec-9', title: 'T', url: 'https://u' },
      }) ?? '';

    expect(out).toContain('You are working in Memex (ns/mx)');
    expect(out).toContain('Spec spec-9 "T"');
    expect(out).toContain("ref: 'ns/mx/specs/spec-9'");
    // It absorbs the Spec: get_doc, list_acs, list_comments.
    expect(out).toMatch(/get_doc/);
    expect(out).toMatch(/list_acs/);
    expect(out).toMatch(/list_comments/);
    // It ASKS the user which lens(es) to review through — all four on offer,
    // none assumed.
    expect(out).toMatch(/ask the user which lens/i);
    expect(out).toMatch(/do NOT assume/);
    expect(out).toMatch(/Summary/);
    expect(out).toMatch(/Security/);
    expect(out).toMatch(/Design/);
    expect(out).toMatch(/Architecture/);
    // Findings are captured as review comments or Issues.
    expect(out).toMatch(/add_comment\([^)]*type: 'review'|type: 'review'/);
    expect(out).toMatch(/register_issue/);
    // no token left unfilled
    expect(out).not.toMatch(/\{(?:namespace|memex|handle|title|url)\}/);
  });

  // spec-159 ac-19: a reviewer OBSERVES — the handoff must NEVER push the agent
  // into editor mutations (resolve decisions, create tasks/ACs, move phase).
  // Pin the no-mutation instruction so a copy-edit can't quietly drop it.
  it('review-handoff forbids editor mutations — reviews observe, editors decide', () => {
    tagAc('mindset-prod/memex-building-itself/specs/spec-159/acs/ac-19');

    const out =
      toButtonPrompt({
        dataset: BASE_SCAFFOLD,
        buttonId: 'review-handoff',
        context: { namespace: 'ns', memex: 'mx', handle: 'spec-9', title: 'T', url: 'https://u' },
      }) ?? '';

    // Explicit "do NOT" gate on every editor-side mutation.
    expect(out).toMatch(/resolve_decision/);
    expect(out).toMatch(/create_task/);
    expect(out).toMatch(/create_ac/);
    expect(out).toMatch(/Do NOT/);
    // The framing that draws the line: reviews observe, editors decide.
    expect(out).toMatch(/reviewing observes; editing decides|reviews observe; editors decide|observe.*decide/i);
  });
});

// ── ac-4: Copy emits exactly the composed output ─────────────────────────

describe('toButtonPrompt is the byte-for-byte source of what Copy emits (ac-4)', () => {
  it('renders a base node with context to the exact expected string', () => {
    tagAc(AC(4));

    const dataset = datasetWith([makeButton({ id: 'b', text: 'Hello ${name}, do ${task}.' })]);
    const out = toButtonPrompt({ dataset, buttonId: 'b', context: { name: 'Ada', task: 'planning' } });
    expect(out).toBe('Hello Ada, do planning.');
  });
});

// ── totality: missing node + safe missing-context ────────────────────────

describe('toButtonPrompt totality', () => {
  it('returns null when no PromptButtonNode matches buttonId', () => {
    const dataset = datasetWith([makeButton({ id: 'b' })]);
    expect(toButtonPrompt({ dataset, buttonId: 'nope', context: {} })).toBeNull();
  });

  it('leaves unresolved ${placeholders} intact and never throws', () => {
    const dataset = datasetWith([makeButton({ id: 'b', text: 'Hi ${name}, ${missing} here.' })]);
    const out = toButtonPrompt({ dataset, buttonId: 'b', context: { name: 'Ada' } });
    expect(out).toBe('Hi Ada, ${missing} here.');
  });
});
