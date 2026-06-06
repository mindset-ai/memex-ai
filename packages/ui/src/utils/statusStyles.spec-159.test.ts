import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { statusVariant } from './statusStyles';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-159/acs/ac-${n}`;

describe('spec-159 t-1: phase status colour mapping (ac-12)', () => {
  it('maps verify to the success (green) variant', () => {
    tagAc(AC(12));
    expect(statusVariant('verify')).toBe('success');
  });

  it('keeps specify on the warning variant', () => {
    tagAc(AC(12));
    expect(statusVariant('specify')).toBe('warning');
  });

  it('keeps build, implementation, and in_progress on the info variant', () => {
    tagAc(AC(12));
    expect(statusVariant('build')).toBe('info');
    expect(statusVariant('implementation')).toBe('info');
    expect(statusVariant('in_progress')).toBe('info');
  });
});
