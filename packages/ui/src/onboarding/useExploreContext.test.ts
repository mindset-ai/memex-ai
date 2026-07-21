import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { entityFromPath } from './useExploreContext';

// spec-502 ac-17: the companion reacts to the in-view entity — a change in the
// route is the trigger. entityFromPath is the pure detector that turns "where the
// user clicked" into "which entity", so a different route yields a different entity.
const AC_REACTS =
  'mindset-prod/memex-building-itself/specs/spec-502/acs/ac-17';

const NS = '/mindset-prod/memex-building-itself';

describe('spec-502 ac-17: entityFromPath maps the in-view route to an entity', () => {
  it('maps a spec detail route to a spec entity with its handle', () => {
    tagAc(AC_REACTS);
    expect(entityFromPath(`${NS}/specs/spec-482`)).toEqual({ kind: 'spec', handle: 'spec-482' });
  });

  it('maps a standard detail route to a standard entity', () => {
    tagAc(AC_REACTS);
    expect(entityFromPath(`${NS}/standards/std-28`)).toEqual({ kind: 'standard', handle: 'std-28' });
  });

  it('maps a doc detail route to a doc entity', () => {
    tagAc(AC_REACTS);
    expect(entityFromPath(`${NS}/docs/doc-19`)).toEqual({ kind: 'doc', handle: 'doc-19' });
  });

  it('maps a skill detail route to a skill entity', () => {
    tagAc(AC_REACTS);
    expect(entityFromPath(`${NS}/skills/skill-3`)).toEqual({ kind: 'skill', handle: 'skill-3' });
  });

  it('maps a spec decision deep-link to a decision entity', () => {
    tagAc(AC_REACTS);
    expect(entityFromPath(`${NS}/specs/spec-64/decisions/dec-3`)).toEqual({
      kind: 'decision',
      handle: 'dec-3',
    });
  });

  it('maps a spec issue deep-link to an issue entity', () => {
    tagAc(AC_REACTS);
    expect(entityFromPath(`${NS}/specs/spec-64/issues/i-2`)).toEqual({
      kind: 'issue',
      handle: 'i-2',
    });
  });

  it('maps the index and /trails to the whole-vault graph', () => {
    tagAc(AC_REACTS);
    expect(entityFromPath(`${NS}`)).toEqual({ kind: 'trail' });
    expect(entityFromPath(`${NS}/trails`)).toEqual({ kind: 'trail' });
  });

  it('gives each board / list surface its own distinct kind (not a generic "item")', () => {
    tagAc(AC_REACTS);
    expect(entityFromPath(`${NS}/specs`)).toEqual({ kind: 'specs-board' });
    expect(entityFromPath(`${NS}/specs/tags`)).toEqual({ kind: 'tags' });
    expect(entityFromPath(`${NS}/decisions`)).toEqual({ kind: 'decisions-board' });
    expect(entityFromPath(`${NS}/standards`)).toEqual({ kind: 'standards-board' });
    expect(entityFromPath(`${NS}/docs`)).toEqual({ kind: 'docs-board' });
    expect(entityFromPath(`${NS}/skills`)).toEqual({ kind: 'skills-board' });
    expect(entityFromPath(`${NS}/issues`)).toEqual({ kind: 'issues-board' });
  });

  it('maps tool / analytics / config surfaces to their own kinds', () => {
    tagAc(AC_REACTS);
    expect(entityFromPath(`${NS}/pulse`)).toEqual({ kind: 'pulse' });
    expect(entityFromPath(`${NS}/insights`)).toEqual({ kind: 'insights' });
    expect(entityFromPath(`${NS}/qa-reports`)).toEqual({ kind: 'qa-reports' });
    expect(entityFromPath(`${NS}/drift`)).toEqual({ kind: 'drift' });
    expect(entityFromPath(`${NS}/scaffold`)).toEqual({ kind: 'scaffold' });
    expect(entityFromPath(`${NS}/settings`)).toEqual({ kind: 'settings' });
    expect(entityFromPath(`${NS}/keys`)).toEqual({ kind: 'keys' });
  });

  it('a different route yields a different entity — the reactive trigger', () => {
    tagAc(AC_REACTS);
    const a = entityFromPath(`${NS}/specs/spec-1`);
    const b = entityFromPath(`${NS}/standards/std-1`);
    expect(a).not.toEqual(b);
    // Two different boards are also distinct — every screen says something specific.
    expect(entityFromPath(`${NS}/specs`)).not.toEqual(entityFromPath(`${NS}/pulse`));
  });

  it('ignores query and hash when deriving the entity', () => {
    tagAc(AC_REACTS);
    expect(entityFromPath(`${NS}/specs/spec-7?tab=decisions#top`)).toEqual({
      kind: 'spec',
      handle: 'spec-7',
    });
  });
});
