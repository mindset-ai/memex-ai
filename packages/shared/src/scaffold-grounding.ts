// spec-360 t-2 / t-3: scaffold-assistant grounding + change validation.
//
// Two pure functions, shared across the server (authoritative) and the React UI
// (instant feedback) so both surfaces agree on what the scaffold means:
//
//   - `toScaffoldGrounding(dataset, orgBlocks)` composes the deterministic
//     grounding the `scaffold` agent mode is fed (dec-5 / dec-10). It is built
//     from the SAME projections the runtime uses (`toPhaseGuidance`, `toNudge`,
//     `toRubric`), so the assistant's explanations and derived targets cannot
//     drift from what the agents actually receive (ac-5). It carries no
//     `rationale` strings that aren't deliberately surfaced (the human-facing
//     "why") — the agent reads structure + the real composed prose + the org's
//     live additions WITH their ids (so edit/disable/delete can name a block).
//
//   - `validateScaffoldChange(dataset, target, text)` is the dec-9 guard. Before
//     a proposal is ever emitted, a requested change is classified: `impossible`
//     (a target that can't exist — e.g. a tool blocked in the named phase) is
//     HARD-REFUSED; `incoherent` (empty text, an untargeted org-global that
//     dilutes every nudge, or a verbatim duplicate of base prose) gets a
//     PUSHBACK with a suggested correction; only `ok` becomes a proposal.
//
// House style mirrors scaffold-model.ts: plain data, pure functions, no I/O.
// Portable per std-22 — the prose names no language/framework/repo/path.

import type {
  GuidanceBlock,
  GuidanceEmphasis,
  GuidanceTarget,
  Phase,
  ScaffoldDataset,
} from './scaffold-model.js';
import { toPhaseGuidance, toRubric } from './scaffold-model.js';

const PHASE_ORDER: readonly Phase[] = ['draft', 'specify', 'build', 'verify', 'done'];

const SEP = '\n\n';

/** Plain-language description of where a target attaches — the same vocabulary
 *  the Inspect UI uses, so an explanation reads the same as the surface. */
export function describeScaffoldTarget(target: GuidanceTarget): string {
  const parts: string[] = [];
  if (target.tool) parts.push(`when \`${target.tool}\` runs`);
  if (target.transition) parts.push(`at the →${target.transition} gate`);
  if (target.button) parts.push(`on the \`${target.button}\` button`);
  if (target.phase) parts.push(`during the ${target.phase} phase`);
  if (parts.length === 0) return 'to every tool response, in every phase (an org-global)';
  return parts.join(' ');
}

function sameTarget(a: GuidanceTarget, b: GuidanceTarget): boolean {
  return (
    a.phase === b.phase &&
    a.tool === b.tool &&
    a.transition === b.transition &&
    a.button === b.button
  );
}

function isUntargeted(t: GuidanceTarget): boolean {
  return (
    t.phase === undefined &&
    t.tool === undefined &&
    t.transition === undefined &&
    t.button === undefined
  );
}

function normalise(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

// ──────────────────────────────────────────────────────────────────────────
// dec-2 / dec-4 — the propose-then-confirm wire contract.
//
// `propose_scaffold_change` (server tool, t-3) WRITES NOTHING. It returns a
// structured ScaffoldProposal so the React surface can render the drafted change
// COMPOSED in the live preview (ac-2 / ac-9) for the admin to approve; only on
// approval does the existing admin-gated scaffold-additions route perform the
// write (ac-8). The contract lives here so the server (emit) and the UI (parse)
// can never drift. The proposal rides the tool result after a marker so the
// chat surface shows only the leading human summary (the codebase's
// `result.split('\n\n', 1)[0]` display convention).
// ──────────────────────────────────────────────────────────────────────────

export type ScaffoldOperation = 'add' | 'edit' | 'disable' | 'enable' | 'delete';

export interface ScaffoldProposal {
  operation: ScaffoldOperation;
  /** add: where the new guidance attaches. edit/disable/enable/delete: the
   *  resolved target of the referenced block (echoed so the timeline can navigate). */
  target?: GuidanceTarget;
  /** add: the new guidance text. edit: the replacement text. */
  text?: string;
  /** add (spec-360): the scope of a new block — `'org'` (org-wide, the default:
   *  applies to every Memex in the org) or `'memex'` (this Memex only). Resolved
   *  to a memexId at approve time by the surface. Omitted = org-wide. */
  scope?: 'org' | 'memex';
  /** add: the human-facing rationale (note to admins, never sent to agents). */
  rationale?: string;
  /** add: optional emphasis. */
  emphasis?: GuidanceEmphasis;
  /** edit/disable/enable/delete: the existing org block id being changed. */
  blockId?: string;
  /** edit/disable/enable/delete: the current state, for the before/after preview. */
  before?: { text?: string; enabled?: boolean; target?: GuidanceTarget };
  /** A one-line human summary — what the chat card shows. */
  summary: string;
}

export const SCAFFOLD_PROPOSAL_MARKER = '<<<SCAFFOLD_PROPOSAL>>>';

/** Encode a proposal onto a tool result: a human summary line, then the marker
 *  + JSON the UI parses. The blank line keeps the summary as the chat display. */
export function encodeScaffoldProposal(proposal: ScaffoldProposal): string {
  return `${proposal.summary}\n\n${SCAFFOLD_PROPOSAL_MARKER}${JSON.stringify(proposal)}`;
}

/** Parse a proposal out of a tool result, or null if the result carries none
 *  (a refusal/pushback, an explain answer, anything else). */
export function parseScaffoldProposal(result: string): ScaffoldProposal | null {
  const at = result.indexOf(SCAFFOLD_PROPOSAL_MARKER);
  if (at === -1) return null;
  const json = result.slice(at + SCAFFOLD_PROPOSAL_MARKER.length).trim();
  try {
    const parsed = JSON.parse(json) as ScaffoldProposal;
    if (!parsed || typeof parsed.operation !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// dec-9 — validate-and-pushback.
// ──────────────────────────────────────────────────────────────────────────

export type ProposalValidation =
  | { outcome: 'ok' }
  | { outcome: 'impossible'; reason: string }
  | { outcome: 'incoherent'; reason: string; suggestion: string };

/**
 * Classify a requested org-guidance change BEFORE any proposal is drafted
 * (dec-9). Pure: it reads only the scaffold structure + base prose, so the
 * server and the UI reach the same verdict.
 */
export function validateScaffoldChange(
  dataset: ScaffoldDataset,
  target: GuidanceTarget,
  text: string,
): ProposalValidation {
  const toolNames = new Set(dataset.tools.map((t) => t.name));

  // IMPOSSIBLE — a target that cannot exist.
  if (target.tool !== undefined && !toolNames.has(target.tool)) {
    return {
      outcome: 'impossible',
      reason: `There is no tool named "${target.tool}" in the scaffold, so nothing would ever read this guidance.`,
    };
  }
  if (target.tool !== undefined && target.phase !== undefined) {
    const phaseNode = dataset.phases.find((p) => p.phase === target.phase);
    if (phaseNode && phaseNode.allowance.blocked.includes(target.tool)) {
      return {
        outcome: 'impossible',
        reason: `\`${target.tool}\` does not run during the ${target.phase} phase — it is blocked there — so guidance attached to that circumstance would never fire.`,
      };
    }
  }
  if (
    target.button !== undefined &&
    !dataset.promptButtons.some((b) => b.id === target.button)
  ) {
    return {
      outcome: 'impossible',
      reason: `There is no Prompt Button "${target.button}" in the scaffold.`,
    };
  }

  // INCOHERENT — a coherent target but bad content/placement.
  if (text.trim().length === 0) {
    return {
      outcome: 'incoherent',
      reason: 'The guidance text is empty — the agent would receive nothing to act on.',
      suggestion: 'Say concretely what the agent should do at this circumstance.',
    };
  }
  if (isUntargeted(target)) {
    return {
      outcome: 'incoherent',
      reason:
        'An untargeted addition rides every tool response in every phase, which dilutes every nudge and buries the guidance that is actually relevant.',
      suggestion:
        'Scope it to a phase, a tool, or a gate so it fires only where it matters — e.g. attach it to the build phase or to the tool you mean.',
    };
  }
  const duplicatesBase = dataset.baseGuidance.some(
    (b) =>
      b.source === 'base' &&
      sameTarget(b.target, target) &&
      normalise(b.text) === normalise(text),
  );
  if (duplicatesBase) {
    return {
      outcome: 'incoherent',
      reason:
        'This repeats guidance the built-in scaffold already provides at this exact circumstance — the agents already receive it.',
      suggestion:
        'Drop it, or say what you want to ADD beyond what the built-in guidance already says here.',
    };
  }

  return { outcome: 'ok' };
}

// ──────────────────────────────────────────────────────────────────────────
// dec-5 / dec-10 — the grounding the `scaffold` mode is fed.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Compose the scaffold grounding for the assistant's system prompt.
 *
 * Three layers (dec-5): (1) the STRUCTURE — phases, gates, tools, buttons, the
 * `target` grammar, and the base-first composition + two-agent-parity rules;
 * (2) the org's LIVE ADDITIONS, each with its id (so edit/disable/delete can
 * reference a specific block); (3) the real composed prose per phase / gate,
 * drawn from the SAME projections (`toPhaseGuidance`, `toNudge`, `toRubric`) the
 * runtime emits — so the assistant's claims are checkable against the agents'
 * actual input (ac-5).
 *
 * `orgBlocks` are the org's `source: 'org'` additions, already filtered to the
 * caller's org + memex scope. The whole result is injected as ONE cacheable
 * system block (dec-10) — large but stable within a session.
 */
export function toScaffoldGrounding(
  dataset: ScaffoldDataset,
  orgBlocks: readonly GuidanceBlock[] = [],
): string {
  const sections: string[] = [];

  sections.push(
    '## The scaffold you administer\n' +
      'The scaffold is the single source of the prompting every agent in this Memex receives. ' +
      'It is projected to two surfaces with PARITY: the MCP coding agent and the in-app agent both read the same composed guidance. ' +
      'Guidance composes BASE-FIRST: the built-in blocks come first, then the org\'s additions, read as one coherent set (there is no "override" — additions append).\n\n' +
      'Every block attaches to a `target` with four optional dimensions; an absent dimension matches every value:\n' +
      '- `phase` — one of draft, specify, build, verify, done (the lifecycle stage).\n' +
      '- `tool` — a specific tool; the guidance rides that tool\'s response.\n' +
      '- `transition` — a forward gate (→specify / →build / →verify / →done); the guidance joins that gate\'s rubric.\n' +
      '- `button` — a Prompt Button; the guidance appends to that button\'s prompt.\n\n' +
      'You author ORG guidance only — the base scaffold is read-only. You never write silently: you draft a change and the admin approves it on the timeline.',
  );

  // Layer 1 + 3 — structure and the real composed prose, per phase.
  for (const phase of PHASE_ORDER) {
    const node = dataset.phases.find((p) => p.phase === phase);
    if (!node) continue;
    const lines: string[] = [`### Phase: ${phase}`, node.intent];
    if (node.allowance.allowed.length > 0) {
      lines.push(`Tools this phase opens up: ${node.allowance.allowed.join(', ')}.`);
    }
    if (node.allowance.blocked.length > 0) {
      lines.push(`Tools this phase blocks: ${node.allowance.blocked.join(', ')}.`);
    }
    const guidance = toPhaseGuidance(dataset, phase === 'draft' ? 'specify' : phase);
    if (guidance.length > 0) {
      lines.push(`Composed phase guidance the agent receives:\n${guidance}`);
    }
    sections.push(lines.join('\n'));
  }

  // Layer 1 + 3 — TOOL-SPECIFIC guidance only. We list the base + org blocks that
  // actually target a specific `tool` (each once), NOT a per-(tool, phase)
  // re-composition: every tool's runtime nudge is "the phase guidance above" plus
  // any tool-specific block here, so the assistant can answer "what does the agent
  // read when create_task runs in build?" by combining the two without us
  // re-emitting the whole phase guidance for all ~30 tools × 5 phases (which would
  // balloon the prompt past the context window).
  const toolTargeted = [...dataset.baseGuidance, ...orgBlocks].filter(
    (b) => b.target.tool !== undefined && (b.source === 'base' || b.enabled),
  );
  if (toolTargeted.length > 0) {
    const lines = toolTargeted.map((b) => {
      const src = b.source === 'org' ? ' [your org]' : '';
      const phaseScope = b.target.phase ? ` during ${b.target.phase}` : ' (all phases)';
      return `- \`${b.target.tool}\`${phaseScope}${src}:\n  ${b.text.replace(/\n/g, '\n  ')}`;
    });
    sections.push(
      `### Tool-specific guidance (rides ON TOP of the phase guidance above, for that tool only)\n${lines.join('\n')}`,
    );
  }

  // Layer 1 + 3 — gate rubrics, from `toRubric`.
  const rubrics: string[] = [];
  for (const t of dataset.transitions) {
    const rubric = toRubric({ dataset, transition: t.transition, orgBlocks });
    if (rubric.length > 0) {
      rubrics.push(`- →${t.transition} gate:\n${rubric}`);
    }
  }
  if (rubrics.length > 0) {
    sections.push(`### Gate rubrics (walked at each forward transition)\n${rubrics.join('\n')}`);
  }

  // Layer 1 — Prompt Buttons.
  if (dataset.promptButtons.length > 0) {
    const buttons = dataset.promptButtons
      .map((b) => `- \`${b.id}\` — "${b.label}"`)
      .join('\n');
    sections.push(`### Prompt Buttons\n${buttons}`);
  }

  // Layer 2 — the org's LIVE additions, with ids (so edit/disable/delete can
  // name the exact block). This is the only place ids appear.
  if (orgBlocks.length > 0) {
    const rows = orgBlocks
      .map((b) => {
        const id = (b as GuidanceBlock & { id?: string }).id ?? '(no id)';
        const state = b.enabled ? 'enabled' : 'DISABLED';
        const emph = b.emphasis ? ` [${b.emphasis}]` : '';
        return `- id \`${id}\` (${state})${emph} — applies ${describeScaffoldTarget(b.target)}:\n  ${b.text.replace(/\n/g, '\n  ')}`;
      })
      .join('\n');
    sections.push(`### Your org's current additions\n${rows}`);
  } else {
    sections.push(
      "### Your org's current additions\nNone yet — your org has added no guidance. Every block above is built-in.",
    );
  }

  return sections.join(SEP);
}
