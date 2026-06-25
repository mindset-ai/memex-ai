// spec-372 issues 13–16 — the prompt spec-token resolver.
import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { resolveSpecToken, SPEC_TOKEN_PLACEHOLDER } from './specToken';
import type { DocSummary } from '../../api/types';

const AC372 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-372/acs/ac-${n}`;

function spec(over: Partial<DocSummary>): DocSummary {
  return {
    id: over.id ?? 'd1',
    handle: over.handle ?? 'spec-1',
    title: 'X',
    docType: 'spec',
    status: 'build',
    parentDocId: null,
    createdAt: '',
    statusChangedAt: '',
    sectionCount: 0,
    pausedAt: over.pausedAt ?? null,
    archivedAt: over.archivedAt ?? null,
    isDemo: over.isDemo,
  } as DocSummary;
}

describe('resolveSpecToken (spec-372 issues 13–16)', () => {
  it('uses the handle when exactly one real (non-demo) spec exists', () => {
    tagAc(AC372(45));
    const docs = [spec({ handle: 'spec-376' }), spec({ id: 'demo', handle: 'spec-1', isDemo: true })];
    expect(resolveSpecToken(docs)).toBe('spec-376');
  });

  it('falls back to the placeholder when more than one real spec exists', () => {
    const docs = [spec({ handle: 'spec-376' }), spec({ id: 'd2', handle: 'spec-377' })];
    expect(resolveSpecToken(docs)).toBe(SPEC_TOKEN_PLACEHOLDER);
  });

  it('falls back to the placeholder when only demo specs exist', () => {
    const docs = [spec({ isDemo: true }), spec({ id: 'd2', isDemo: true })];
    expect(resolveSpecToken(docs)).toBe(SPEC_TOKEN_PLACEHOLDER);
  });

  it('ignores archived/paused specs when counting', () => {
    const docs = [spec({ handle: 'spec-376' }), spec({ id: 'd2', handle: 'spec-377', archivedAt: 'x' }), spec({ id: 'd3', handle: 'spec-378', pausedAt: 'x' })];
    expect(resolveSpecToken(docs)).toBe('spec-376');
  });

  it('falls back to the placeholder when there are no specs', () => {
    expect(resolveSpecToken([])).toBe(SPEC_TOKEN_PLACEHOLDER);
  });
});
