// spec-544 dec-5 / ac-20 — the attribution handoff's PROSE lives in the Scaffold.
//
// Writing a Standard's repo attribution is MCP-only, so std-34 cl-2 requires the
// Standards surface to carry an explicit handoff rather than leaving the reader
// stuck at a state they can see and cannot change. std-23 and std-34 cl-3 put the
// prompt body here, in the Scaffold, and never in the React client — cl-1 keeps
// tool names out of the copy a person reads.
//
// This file asserts the Scaffold half. The client half (wired by id, no inlined
// prose) is asserted next to the page it governs, in
// packages/ui/src/pages/Standard.attribution-handoff.spec-544.test.ts.

import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { toButtonPrompt } from './scaffold-model.js';
import { BASE_SCAFFOLD } from './scaffold-data.js';

const AC20 = 'mindset-prod/memex-building-itself/specs/spec-544/acs/ac-20';
const BUTTON_ID = 'attribute-standard';

const node = () => BASE_SCAFFOLD.promptButtons.find((b) => b.id === BUTTON_ID);

describe('spec-544 — the attribution Prompt Button (ac-20)', () => {
  it('exists, and is offered on the standard-detail surface', () => {
    tagAc(AC20);
    const b = node();
    expect(
      b,
      `Scaffold must carry the '${BUTTON_ID}' Prompt Button — a surface whose next ` +
        `step is MCP-only needs a handoff (std-34 cl-2).`,
    ).toBeTruthy();
    expect(b!.surfaces).toContain('standard-detail');
  });

  it('names the ACTION in its label, never the tool (cl-4)', () => {
    tagAc(AC20);
    const label = node()!.label;

    // cl-4: the highlighted link text says what the prompt DOES. "Run update_doc"
    // would be the agent-facing leak cl-1 forbids.
    expect(label.toLowerCase()).toMatch(/attribut/);
    for (const leak of ['update_doc', 'get_information', 'search_memex', 'MCP', '()']) {
      expect(label, `the label must not contain "${leak}"`).not.toContain(leak);
    }
  });

  it('teaches the FLAT tag shape, so a scoped value cannot silently displace one', () => {
    tagAc(AC20);
    const text = node()!.text;

    // The prompt is agent-facing — this is the one place cl-3 permits the tool
    // name.
    expect(text).toContain('update_doc');
    expect(text).toMatch(/memex-ai/);
    expect(text).toMatch(/memex-clients/);

    // dec-1's whole argument: a scoped `repo::x` is mutually exclusive within its
    // scope, so applying it drops any other `repo::*`. An agent that reaches for
    // one would silently halve the attribution of a Standard binding both repos.
    // The prompt has to say so, or the next agent re-derives the bug.
    expect(
      text,
      'The prompt must warn against a scoped tag and ask for flat labels.',
    ).toMatch(/flat/i);
    expect(text).toMatch(/scope|::/);
  });

  it('composes into a prompt with no unresolved placeholders', () => {
    tagAc(AC20);
    const composed = toButtonPrompt({
      dataset: BASE_SCAFFOLD,
      buttonId: BUTTON_ID,
      context: {
        namespace: 'mindset-prod',
        memex: 'memex-building-itself',
        handle: 'std-44',
        title: 'Flutter clients run through fvm',
        url: 'https://memex.ai/mindset-prod/memex-building-itself/standards/std-44',
      },
    });

    expect(composed).toContain('std-44');
    expect(
      composed,
      'An un-interpolated {token} in a copied prompt hands the agent a literal ' +
        'placeholder — worse than omitting the context entirely.',
    ).not.toMatch(/\{(namespace|memex|handle|title|url)\}/);
  });
});
