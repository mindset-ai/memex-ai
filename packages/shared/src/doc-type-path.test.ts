// spec-380 dec-1 (ac-5): the consolidated docType → ref-path-segment mapping must
// be byte-identical to the two former local copies (taskInitPrompt / specInitPrompt).
// These cases pin every branch of the switch, including the default fall-through.
import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { docTypePath } from './doc-type-path.js';

const AC5 = 'mindset-prod/memex-building-itself/specs/spec-380/acs/ac-5';
// ac-2 (scope): docTypePath exists in exactly one location, byte-identical output.
const AC2 = 'mindset-prod/memex-building-itself/specs/spec-380/acs/ac-2';

describe('docTypePath — shared canonical docType→segment mapping (spec-380 dec-1)', () => {
  it('maps each known docType to its std-10 §2 ref segment', () => {
    tagAc(AC5);
    tagAc(AC2);
    expect(docTypePath('spec')).toBe('specs');
    expect(docTypePath('standard')).toBe('standards');
    expect(docTypePath('execution_plan')).toBe('execution-plans');
  });

  it('falls through to "docs" for free-form and any unrecognised docType', () => {
    tagAc(AC5);
    tagAc(AC2);
    expect(docTypePath('document')).toBe('docs');
    expect(docTypePath('')).toBe('docs');
    expect(docTypePath('anything-else')).toBe('docs');
  });
});
