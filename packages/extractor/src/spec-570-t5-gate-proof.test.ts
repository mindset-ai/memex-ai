// spec-570 t-5 — DELIBERATELY FAILING. Temporary, on a throwaway branch only.
//
// Round 2, the mirror of round 1: `extractor` must go red while `shared`
// returns to green. Round 1 proved a red `shared` blocks the merge; this proves
// the two contexts are independent in BOTH directions, which is the whole
// argument for two jobs instead of one combined [per dec-2].
//
// DELETE BEFORE THIS BRANCH GOES ANYWHERE NEAR develop. The branch is closed,
// never merged — see the Spec's t-5.
import { describe, it, expect } from 'vitest';

describe('spec-570 t-5: deliberate failure proving the `extractor` context gates', () => {
  it('FAILS ON PURPOSE — if this is green, the proof did not run', () => {
    expect('the extractor job gates').toBe('this assertion must fail');
  });
});
