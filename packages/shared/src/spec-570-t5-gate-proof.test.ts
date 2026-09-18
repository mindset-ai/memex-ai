// spec-570 t-5 — DELIBERATELY FAILING. Temporary, on a throwaway branch only.
//
// ac-2 requires the gate be "demonstrated against the live protection state, not
// inferred from the workflow file". This file is that demonstration for the
// `shared` context: it must turn `shared` red, leave `extractor` green, and the
// PR carrying it must become unmergeable.
//
// DELETE BEFORE THIS BRANCH GOES ANYWHERE NEAR develop. The branch is closed,
// never merged — see the Spec's t-5.
import { describe, it, expect } from 'vitest';

describe('spec-570 t-5: deliberate failure proving the `shared` context gates', () => {
  it('FAILS ON PURPOSE — if this is green, the proof did not run', () => {
    expect('the shared job gates').toBe('this assertion must fail');
  });
});
