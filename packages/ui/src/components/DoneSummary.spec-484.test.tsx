// spec-484 t-3 / dec-2 — DoneSummary "Read the spec" prose renders markdown.
//
// The read-the-spec record printed decision resolutions (whitespace-pre-wrap)
// and AC statements as plain text. This pins that:
//   • ac-7  — a decision resolution renders as block markdown (li + strong)
//   • ac-8  — an AC statement renders inline markdown (`code` → <code>)
//   • ac-13 — both route through the shared markdown renderer, not literal text
//
// DoneSummary takes plain props and makes no network call, so no providers are
// needed.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, within } from '@testing-library/react';
import { tagAc } from '@memex-ai-ac/vitest';
import { DoneSummary } from './DoneSummary';
import type { Decision, DocWithGraph } from '../api/types';
import type { AcWithVerification } from '../api/client';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-484/acs/ac-${n}`;

const CREATED_AT = '2026-06-02T12:00:00Z';
const COMPLETED_AT = '2026-06-09T12:00:00Z';

function makeDoc(overrides: Partial<DocWithGraph> = {}): DocWithGraph {
  return {
    id: 'doc-uuid',
    handle: 'spec-484',
    title: 'Render correctness',
    docType: 'spec',
    status: 'done',
    creator: { name: 'Tester', email: 'tester@memex.ai' },
    createdAt: CREATED_AT,
    statusChangedAt: COMPLETED_AT,
    sections: [],
    decisions: [],
    tasks: [],
    ...overrides,
  } as DocWithGraph;
}

function makeDecision(): Decision {
  return {
    id: 'dec-1',
    docId: 'doc-uuid',
    seq: 1,
    title: 'Which database?',
    context: null,
    status: 'resolved',
    resolution: 'Chose Postgres:\n\n- **Mature** ecosystem\n- Strong SQL',
    resolvedAt: COMPLETED_AT,
    createdAt: CREATED_AT,
    options: null,
    chosenOptionIndex: null,
  } as Decision;
}

function makeAc(): AcWithVerification {
  return {
    ac: {
      id: 'ac-1',
      memexId: 'memex',
      briefId: 'doc-uuid',
      seq: 1,
      kind: 'implementation',
      statement: 'The `login` form rejects **bad** passwords',
      status: 'active',
      acceptedBy: null,
      acceptedAt: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
    canonicalRef: 'ns/m/specs/spec-484/acs/ac-1',
    tests: [],
    verificationState: 'verified',
    daysSinceLastRun: null,
    parents: [],
  } as AcWithVerification;
}

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, 'fetch' as never).mockImplementation((() => {
    throw new Error('DoneSummary must not fetch');
  }) as never);
});
afterEach(() => fetchSpy.mockRestore());

describe('spec-484: DoneSummary read-the-spec prose renders markdown', () => {
  it('ac-7 / ac-13: a decision resolution renders as block markdown (li + strong)', () => {
    tagAc(AC(7));
    tagAc(AC(13));
    const { getByTestId } = render(
      <DoneSummary
        doc={makeDoc()}
        decisions={[makeDecision()]}
        tasks={[]}
        acs={[]}
        issues={[]}
      />,
    );
    fireEvent.click(getByTestId('done-read-spec'));
    const decision = getByTestId('done-read-decision');
    expect(decision.querySelector('li')).not.toBeNull();
    expect(decision.querySelector('strong')?.textContent).toBe('Mature');
    expect(decision.textContent).not.toContain('- **Mature**');
  });

  it('ac-8 / ac-13: an AC statement renders inline markdown (`code` → <code>)', () => {
    tagAc(AC(8));
    tagAc(AC(13));
    const { getByTestId } = render(
      <DoneSummary
        doc={makeDoc()}
        decisions={[]}
        tasks={[]}
        acs={[makeAc()]}
        issues={[]}
      />,
    );
    fireEvent.click(getByTestId('done-read-spec'));
    const acRow = getByTestId('done-read-ac');
    expect(within(acRow).getByText('login').tagName).toBe('CODE');
    expect(acRow.querySelector('strong')?.textContent).toBe('bad');
    expect(acRow.textContent).not.toContain('`login`');
  });
});
