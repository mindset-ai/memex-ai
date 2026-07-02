// spec-438 t-2 (ac-7): the Standards empty-state renders the bootstrap doorbell
// as a Scaffold-sourced PromptButton (by buttonId), and inlines NO bootstrap
// protocol prose in the React client. Asserted at the source level (an
// introspection-shaped test, per the ac-emission discipline) so the structural
// commitment — prose in the Scaffold, never in the client (std-15/std-23) —
// cannot silently regress.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tagAc } from '@memex-ai-ac/vitest';

const SPEC = 'mindset-prod/memex-building-itself/specs/spec-438';
const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'StandardList.tsx'),
  'utf8',
);

describe('spec-438 t-2 — standards empty-state bootstrap doorbell (ac-7)', () => {
  it('renders the bootstrap doorbell as a Scaffold PromptButton by id, not inline prose', () => {
    tagAc(`${SPEC}/acs/ac-7`);
    // the empty-state block hands off via the Scaffold button id
    expect(SOURCE).toMatch(/<PromptButton[\s\S]*?buttonId="bootstrap-standards"/);
    // the CTA sits in the empty-state (a stable marker for the region)
    expect(SOURCE).toContain('data-testid="standards-bootstrap-cta"');
  });

  it('inlines NO bootstrap protocol prose in the client (std-15/std-23)', () => {
    tagAc(`${SPEC}/acs/ac-7`);
    // the protocol body lives ONLY in the get_information topic (t-1); none of
    // its distinctive prose may leak into the React client.
    for (const protocolMarker of [
      'READ THE CODE SILENTLY',
      'two registers',
      "topic='authoring-standards'",
      'STEP 1',
    ]) {
      expect(SOURCE, `client must not inline protocol prose ("${protocolMarker}")`).not.toContain(
        protocolMarker,
      );
    }
  });
});
