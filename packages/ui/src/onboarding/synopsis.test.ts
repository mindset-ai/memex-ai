import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { deriveSynopsis, type SynopsisEntity } from './synopsis';

// spec-502 dec-7 / ac-18: deriveSynopsis is a pure, deterministic, portable
// synopsis builder — no LLM, no building-itself-specific hardcoding, and it
// degrades gracefully when only {kind, handle} are known.
const AC_DERIVE =
  'mindset-prod/memex-building-itself/specs/spec-502/acs/ac-18';

describe('spec-502 ac-18: deriveSynopsis — pure, deterministic, portable', () => {
  it('composes a full Spec synopsis from the entity fields', () => {
    tagAc(AC_DERIVE);
    const s = deriveSynopsis({
      kind: 'spec',
      handle: 'spec-482',
      title: 'Post-creation landing',
      summary: 'Land the author on their new Spec, agent continuity intact.',
      status: 'build',
      links: ['dec-4', 'ac-4'],
    });
    expect(s.headline).toBe('Post-creation landing');
    expect(s.body).toContain('Spec spec-482:');
    expect(s.body).toContain('Land the author on their new Spec');
    expect(s.body).toContain('Currently build.');
    expect(s.body).toContain('Related: dec-4, ac-4.');
  });

  it('falls back to a generic gloss when the entity carries no summary', () => {
    tagAc(AC_DERIVE);
    const s = deriveSynopsis({ kind: 'standard', handle: 'std-28' });
    // Headline names the thing ("Standard std-28"); body is what that kind IS.
    expect(s.headline).toBe('Standard std-28');
    expect(s.body).toBe('A durable rule the work is held to.');
  });

  it('carries a screen-specific nudge that ties the view to the create CTA', () => {
    tagAc(AC_DERIVE);
    const skills = deriveSynopsis({ kind: 'skills-board' });
    const specs = deriveSynopsis({ kind: 'specs-board' });
    expect(skills.nudge).toBe('Give your agents Skills like these.');
    expect(specs.nudge).toBe('Track your own work as Specs like these.');
    // Every kind has one, and it never leaves the reader without motivation.
    expect(deriveSynopsis({ kind: 'unknown' }).nudge).toBeTruthy();
    // The nudge changes per screen — part of the reactive re-render.
    expect(skills.nudge).not.toBe(specs.nudge);
  });

  it('gives every board / surface its own distinct headline + body', () => {
    tagAc(AC_DERIVE);
    const specs = deriveSynopsis({ kind: 'specs-board' });
    expect(specs.headline).toBe('Specs');
    expect(specs.body).toContain('Every unit of work here');

    const trails = deriveSynopsis({ kind: 'trail' });
    expect(trails.headline).toBe('Trails');
    expect(trails.body).toContain('knowledge graph');

    const drift = deriveSynopsis({ kind: 'drift' });
    expect(drift.headline).toBe('Drift');
    expect(drift.body).toContain('fallen out of sync');

    // Different surfaces never collapse to the same synopsis.
    expect(specs).not.toEqual(trails);
    expect(specs).not.toEqual(drift);
  });

  it('degrades to a kind-level synopsis when only the kind is known', () => {
    tagAc(AC_DERIVE);
    const s = deriveSynopsis({ kind: 'section' });
    expect(s.headline).toBe('Section');
    expect(s.body).toBe('One part of a larger document.');
  });

  it('handles the unknown kind and empty fields safely', () => {
    tagAc(AC_DERIVE);
    const s = deriveSynopsis({ kind: 'unknown', handle: '', title: '  ', summary: '' });
    expect(s.headline).toBe('Item');
    expect(s.body).toBe('Part of this workspace.');
    // No stray "Currently" / "Related" when status + links are absent.
    expect(s.body).not.toContain('Currently');
    expect(s.body).not.toContain('Related');
  });

  it('caps related links at three', () => {
    tagAc(AC_DERIVE);
    const s = deriveSynopsis({
      kind: 'spec',
      handle: 'spec-1',
      links: ['a', 'b', 'c', 'd', 'e'],
    });
    expect(s.body).toContain('Related: a, b, c.');
    expect(s.body).not.toContain('a, b, c, d');
  });

  it('is portable — no specific-Memex identifiers leak into the copy', () => {
    tagAc(AC_DERIVE);
    // Exercise every kind and assert the generic copy never names a specific
    // workspace / namespace (std-22).
    const kinds: SynopsisEntity['kind'][] = [
      'spec', 'doc', 'standard', 'skill', 'section', 'decision', 'issue', 'task',
      'specs-board', 'standards-board', 'docs-board', 'skills-board', 'decisions-board',
      'issues-board', 'tags', 'drift', 'pulse', 'insights', 'qa-reports', 'settings',
      'keys', 'scaffold', 'org', 'trail', 'home', 'unknown',
    ];
    for (const kind of kinds) {
      const { headline, body, nudge } = deriveSynopsis({ kind });
      const blob = `${headline} ${body} ${nudge}`.toLowerCase();
      expect(blob).not.toContain('building-itself');
      expect(blob).not.toContain('mindset');
      expect(blob).not.toContain('memex-building');
    }
  });

  it('is deterministic — same entity in, same synopsis out', () => {
    tagAc(AC_DERIVE);
    const entity: SynopsisEntity = {
      kind: 'decision',
      handle: 'dec-3',
      title: 'Name-only step',
      status: 'resolved',
    };
    expect(deriveSynopsis(entity)).toEqual(deriveSynopsis(entity));
  });
});
