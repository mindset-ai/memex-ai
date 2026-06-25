// spec-211 t-2 (ac-10 / ac-11): resolving the demo spec to open per phase.

import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { demoSpecForPhase, demoSpecPath, demoSpecPathForPhase } from './demoSpecs';
import type { DocSummary } from '../../api/types';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-211/acs/ac-${n}`;

function doc(partial: Partial<DocSummary>): DocSummary {
  return {
    id: partial.id ?? `id-${partial.handle}`,
    handle: partial.handle ?? 'spec-1',
    title: 'In-app Memex search (⌘K)',
    docType: 'spec',
    status: partial.status ?? 'draft',
    parentDocId: null,
    createdAt: '',
    statusChangedAt: '',
    sectionCount: 0,
    pausedAt: null,
    archivedAt: null,
    isDemo: partial.isDemo,
  } as DocSummary;
}

// Five demo specs (one per phase) + a couple of real specs sharing phases.
const docs: DocSummary[] = [
  doc({ handle: 'spec-90', status: 'draft', isDemo: true }),
  doc({ handle: 'spec-91', status: 'specify', isDemo: true }),
  doc({ handle: 'spec-92', status: 'build', isDemo: true }),
  doc({ handle: 'spec-93', status: 'verify', isDemo: true }),
  doc({ handle: 'spec-94', status: 'done', isDemo: true }),
  doc({ handle: 'spec-7', status: 'build', isDemo: false }), // real spec, same phase
  doc({ handle: 'spec-8', status: 'draft' }), // real spec, isDemo undefined
];

describe('demoSpecForPhase (spec-211 ac-11)', () => {
  it('returns the isDemo doc whose status matches the phase — never a real spec', () => {
    expect(demoSpecForPhase(docs, 'draft')?.handle).toBe('spec-90');
    expect(demoSpecForPhase(docs, 'specify')?.handle).toBe('spec-91');
    expect(demoSpecForPhase(docs, 'build')?.handle).toBe('spec-92'); // not spec-7 (real)
    expect(demoSpecForPhase(docs, 'verify')?.handle).toBe('spec-93');
    expect(demoSpecForPhase(docs, 'done')?.handle).toBe('spec-94');
    tagAc(AC(11));
  });

  it('returns null when no demo spec is seeded for the phase', () => {
    expect(demoSpecForPhase([doc({ handle: 'spec-8', status: 'draft' })], 'verify')).toBeNull();
  });
});

describe('demoSpecPath / demoSpecPathForPhase (spec-211 ac-10)', () => {
  it('builds the /specs/<handle> detail route for the demo spec at a phase', () => {
    // Out of tenant context (jsdom default origin), tenantPath returns the bare path.
    expect(demoSpecPath(doc({ handle: 'spec-92' }))).toBe('/specs/spec-92');
    expect(demoSpecPathForPhase(docs, 'build')).toBe('/specs/spec-92');
    expect(demoSpecPathForPhase(docs, 'done')).toBe('/specs/spec-94');
    tagAc(AC(10));
  });

  it('is null for a phase with no demo spec', () => {
    expect(demoSpecPathForPhase([], 'draft')).toBeNull();
  });
});
