// spec-544 dec-5 / ac-20 — the Standards surface carries a coding-agent handoff,
// and the prose for it lives in the Scaffold.
//
// Source-level by design, matching this repo's existing idiom for structural
// commitments (see StandardList.bootstrap-cta.spec-438). The claim here is not
// "a button appears" — a mounting test would prove that and prove nothing about
// WHERE the words live. The commitment is that prompt prose sits in the Scaffold
// and never in the React client (std-15 / std-23), and that no MCP vocabulary
// leaks into the copy a person reads (std-34 cl-1, cl-3). Both are properties of
// the source, so the source is what gets asserted.
//
// WHY THE HANDOFF IS ON THE DETAIL PAGE AND NOT THE CARDS. Each list card is
// itself a `<Link>`, so anything clickable inside one must stop propagation or it
// navigates instead — the drift badge already carries that workaround. Fifty-two
// copy-buttons, each needing it, is noise. `Standard.tsx` is not wrapped in a
// Link, so one handoff there is both cleaner and unconstrained.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tagAc } from '@memex-ai-ac/vitest';

const AC20 = 'mindset-prod/memex-building-itself/specs/spec-544/acs/ac-20';
const HERE = dirname(fileURLToPath(import.meta.url));
const DETAIL = readFileSync(join(HERE, 'Standard.tsx'), 'utf8');

const BUTTON_ID = 'attribute-standard';

// The Scaffold half — that the button exists, names the action, and teaches the
// flat-tag shape — is asserted where the Scaffold lives:
// packages/shared/src/scaffold-data.spec-544-attribution-button.test.ts.
// This file owns the CLIENT half only.

describe('spec-544: the detail page wires the handoff and inlines no prose (ac-20)', () => {
  it('renders the handoff by buttonId, not by embedding the prompt', () => {
    tagAc(AC20);
    expect(DETAIL).toMatch(
      new RegExp(`<PromptButton[\\s\\S]*?buttonId="${BUTTON_ID}"`),
    );
  });

  it('shows the attribution chips', () => {
    tagAc(AC20);
    expect(DETAIL).toContain('TagChip');
  });

  it('leaks no MCP vocabulary into the copy a person reads (cl-1, cl-3)', () => {
    tagAc(AC20);

    // The prompt text is resolved from the Scaffold by id, so none of these
    // strings should appear in the client at all. If one does, it is on-screen
    // copy telling a human to make a call they cannot make — the trust drain
    // cl-8 records (spec-157: a human told to call get_information reads an
    // instruction they cannot follow and concludes the product is broken).
    for (const leak of [
      'update_doc',
      "get_information(",
      'search_memex(',
      'removeTags',
      'tags: [',
    ]) {
      expect(
        DETAIL,
        `Standard.tsx must not contain "${leak}" — agent vocabulary rendered at a ` +
          `person is a trust drain, and the prompt body belongs in scaffold-data.ts.`,
      ).not.toContain(leak);
    }
  });
});
