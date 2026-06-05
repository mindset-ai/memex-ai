// spec-123 t-4 (dec-6): the four walkthrough affordances moved out of the
// top-bar headerActions into the chat OpeningTurn; the phase pill + utilities
// stay. Asserted at the source level (an introspection-shaped test, per the
// ac-emission discipline) so the structural commitment can't silently regress.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tagAc } from '@memex-ai-ac/vitest';

const SPEC = 'mindset-prod/memex-building-itself/specs/spec-123';
const SOURCE = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'DocDocument.tsx'),
  'utf8',
);

describe('spec-123 t-4 — top-bar headerActions disposition (dec-6)', () => {
  // The disposition that matters is the TOP-BAR header actions — the four
  // walkthrough controls moved into the chat OpeningTurn. spec-159 ac-17 later
  // (re)introduced a PromptButton on the Spec page, but for the in-page
  // phase-handoff line — NOT the header — so the header-region assertion is
  // scoped to the `headerActions` memo to keep guarding the real commitment.
  const HEADER_ACTIONS = SOURCE.slice(
    SOURCE.indexOf('const headerActions = useMemo('),
    SOURCE.indexOf('useHeaderSlot(headerActions)'),
  );

  it('no longer renders the four walkthrough buttons (ac-15)', () => {
    tagAc(`${SPEC}/acs/ac-15`);
    // No JSX usage of the relocated controls in the header actions (comments may
    // name them in prose, so we match the JSX element form `<Name`).
    expect(HEADER_ACTIONS).not.toMatch(/<ResolveDecisionsButton[\s/>]/);
    expect(HEADER_ACTIONS).not.toMatch(/<ResolveCommentsButton[\s/>]/);
    expect(HEADER_ACTIONS).not.toMatch(/<RefreshSpecButton[\s/>]/);
    expect(HEADER_ACTIONS).not.toMatch(/<PromptButton[\s/>]/);
    // And the three relocated buttons' imports are gone. (PromptButton IS
    // imported now — it backs the spec-159 phase-handoff line, not the header.)
    expect(SOURCE).not.toMatch(/import[^\n]*ResolveDecisionsButton/);
    expect(SOURCE).not.toMatch(/import[^\n]*ResolveCommentsButton/);
    expect(SOURCE).not.toMatch(/import[^\n]*RefreshSpecButton/);
  });

  it('still renders the phase control, Share, Download, and the menu (ac-16, ac-1)', () => {
    tagAc(`${SPEC}/acs/ac-16`);
    tagAc(`${SPEC}/acs/ac-1`);
    // spec-159 t-7 retired the PhaseDropdown — the phase control is now the
    // in-page PhaseTabBar + TransitionSentence. The header keeps its utilities.
    expect(SOURCE).not.toMatch(/<PhaseDropdown[\s/>]/);
    expect(SOURCE).toMatch(/<PhaseTabBar[\s/>]/);
    expect(SOURCE).toMatch(/<TransitionSentence[\s/>]/);
    expect(SOURCE).toMatch(/<SpecMenu[\s/>]/);
    expect(SOURCE).toMatch(/>\s*Share\s*</);
    expect(SOURCE).toMatch(/aria-label="Download Spec"/);
  });
});
