// spec-343 t-5 / ac-11: the target language that powers in-context authoring.

import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { describeTarget, broadenOptions, isBroadTarget } from './targets';

const AC = 'mindset-prod/memex-building-itself/specs/spec-343/acs/ac-11';

describe('target language (ac-11)', () => {
  it('describes each circumstance in plain language', () => {
    tagAc(AC);
    expect(describeTarget({ tool: 'create_task', phase: 'build' })).toBe(
      'when create_task runs during build',
    );
    expect(describeTarget({ phase: 'build' })).toBe('during build (every tool)');
    expect(describeTarget({ tool: 'create_task' })).toBe('when create_task runs, in every phase');
    expect(describeTarget({ transition: 'build' })).toBe('at the specify → build gate');
    expect(describeTarget({ button: 'b1' }, 'Start building')).toBe('the "Start building" prompt button');
    expect(describeTarget({})).toBe('every agent response (always applies)');
  });

  it('only the empty target is broad', () => {
    tagAc(AC);
    expect(isBroadTarget({})).toBe(true);
    expect(isBroadTarget({ phase: 'build' })).toBe(false);
    expect(isBroadTarget({ tool: 'x', phase: 'build' })).toBe(false);
  });

  it('broaden relaxes exactly one dimension from a tool-in-phase target', () => {
    tagAc(AC);
    const opts = broadenOptions({ tool: 'create_task', phase: 'build' });
    expect(opts.map((o) => o.target)).toEqual([{ tool: 'create_task' }, { phase: 'build' }]);
    expect(opts.every((o) => !o.broad)).toBe(true);
  });

  it('a phase-wide or tool-wide target can only broaden to org-global (flagged broad)', () => {
    tagAc(AC);
    expect(broadenOptions({ phase: 'build' })).toEqual([
      { label: 'every agent response (org-global)', target: {}, broad: true },
    ]);
    expect(broadenOptions({ tool: 'create_task' })).toEqual([
      { label: 'every agent response (org-global)', target: {}, broad: true },
    ]);
  });

  it('gates, buttons, and org-global have no broader rung', () => {
    tagAc(AC);
    expect(broadenOptions({ transition: 'build' })).toEqual([]);
    expect(broadenOptions({ button: 'b1' })).toEqual([]);
    expect(broadenOptions({})).toEqual([]);
  });
});
