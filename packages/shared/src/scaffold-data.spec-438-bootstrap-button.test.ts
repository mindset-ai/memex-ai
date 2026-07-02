// spec-438 t-2: the cold-start standards-bootstrap Prompt Button (dec-1).
//
// The manual initiation doorbell. Asserts the button's kickoff prose lives in
// the Scaffold (std-23/std-15, ac-7), points the agent at the ONE shared
// artifact — the `standards-bootstrap` get_information topic — rather than
// embedding the protocol body (ac-8/ac-9), is portable per std-22, and composes
// through toButtonPrompt. The single-artifact property (ac-9) is what lets the
// spec-422 empty-state nudge surface the same protocol without re-instrumentation.

import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { toButtonPrompt } from './scaffold-model.js';
import { BASE_SCAFFOLD } from './scaffold-data.js';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-438/acs/ac-${n}`;
const BUTTON_ID = 'bootstrap-standards';
const TOPIC_SLUG = 'standards-bootstrap';

const node = () => BASE_SCAFFOLD.promptButtons.find((b) => b.id === BUTTON_ID);

describe('spec-438 standards-bootstrap Prompt Button', () => {
  it('exists in the Scaffold, on the standards-empty surface, with Scaffold-sourced kickoff prose (ac-7)', () => {
    tagAc(AC(7));
    const b = node();
    expect(b, `Scaffold must carry the '${BUTTON_ID}' Prompt Button`).toBeTruthy();
    expect(b!.surfaces).toContain('standards-empty');
    expect(b!.label.length).toBeGreaterThan(0);
    expect(b!.text.length).toBeGreaterThan(0);
  });

  it('references the single shared bootstrap-protocol artifact and does NOT inline the protocol body (ac-9)', () => {
    tagAc(AC(9));
    const b = node()!;
    // points the agent at the one get_information topic — the shared artifact
    expect(b.text).toContain(`get_information(topic='${TOPIC_SLUG}')`);
    // the kickoff is SHORT — it must not embed the protocol body (those markers
    // live only in the guidance topic, t-1). Guards against a duplicated copy.
    for (const protocolMarker of ['STEP 1', 'two registers', 'INTERNAL', 'READ THE CODE SILENTLY']) {
      expect(
        b.text,
        `kickoff must not inline the protocol body ("${protocolMarker}")`,
      ).not.toContain(protocolMarker);
    }
    // exactly ONE Scaffold button references the bootstrap topic — no fork/dupe
    const referrers = BASE_SCAFFOLD.promptButtons.filter((x) =>
      x.text.includes(`topic='${TOPIC_SLUG}'`),
    );
    expect(referrers).toHaveLength(1);
  });

  it('composes through toButtonPrompt into a copyable kickoff for the coding agent (ac-4)', () => {
    tagAc(AC(4));
    const composed = toButtonPrompt({ dataset: BASE_SCAFFOLD, buttonId: BUTTON_ID, context: {} });
    expect(composed).toBeTruthy();
    expect(composed!).toContain(`get_information(topic='${TOPIC_SLUG}')`);
    // developer-initiated, cold-start framing (interview the developer, draft output)
    expect(composed!).toMatch(/interview|draft/i);
  });

  it('is portable per std-22 — no language / framework / path / tooling assumptions (ac-4)', () => {
    tagAc(AC(4));
    const { text } = node()!;
    for (const token of ['packages/', 'src/', 'pnpm', 'vitest', 'npm ', 'React', 'TypeScript', 'Hono']) {
      expect(text, `kickoff must not hardcode "${token}"`).not.toContain(token);
    }
  });
});
