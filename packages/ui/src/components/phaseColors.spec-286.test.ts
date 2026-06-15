import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { phaseColors } from './phaseColors';

const AC_10 = 'mindset-prod/memex-building-itself/specs/spec-286/acs/ac-10';

// spec-286 dec-3 / ac-10: `done` is no longer null — it returns a neutral grey
// pill (the status-neutral tokens), distinct from build (blue) and verify (teal).
describe('phaseColors — done pill (spec-286)', () => {
  it('ac-10: returns a neutral grey pill for done, distinct from build/verify', () => {
    tagAc(AC_10);

    const done = phaseColors('done');
    expect(done).not.toBeNull();
    expect(done!.pill).toContain('status-neutral');

    // Distinct from the live phases.
    expect(done!.pill).not.toBe(phaseColors('build')!.pill);
    expect(done!.pill).not.toBe(phaseColors('verify')!.pill);

    // Container stays empty so the DocDocument header wash is unaffected at done.
    expect(done!.container).toBe('');
  });
});
