// spec-484 t-3 / dec-2 — AcPill tooltip statement renders inline markdown.
//
// The hover tooltip printed `row.ac.statement` as plain text. This pins that it
// now routes through the shared markdown renderer (inline mode): `code` →
// <code>, `**bold**` → <strong>.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AcPill } from './AcPill';
import type { AcWithVerification, AcVerificationState } from '../api/client';
import { tagAc } from '@memex-ai-ac/vitest';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-484/acs/ac-${n}`;

function row(statement: string): AcWithVerification {
  return {
    ac: {
      id: 'ac-id',
      memexId: 'mx',
      briefId: 'doc-1',
      seq: 3,
      kind: 'scope',
      statement,
      status: 'active',
      acceptedBy: null,
      acceptedAt: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
    canonicalRef: 'ns/mx/specs/spec-484/acs/ac-3',
    tests: [],
    verificationState: 'verified' as AcVerificationState,
    daysSinceLastRun: null,
    parents: [],
  } as AcWithVerification;
}

describe('spec-484: AcPill tooltip renders inline markdown', () => {
  it('ac-8 / ac-13: the statement routes through the markdown renderer (code + strong)', () => {
    tagAc(AC(8));
    tagAc(AC(13));
    render(<AcPill row={row('The `login` form rejects **bad** passwords')} onClick={vi.fn()} />);
    fireEvent.mouseEnter(screen.getByRole('button'));
    const tip = screen.getByRole('tooltip');
    expect(tip.querySelector('code')?.textContent).toBe('login');
    expect(tip.querySelector('strong')?.textContent).toBe('bad');
    expect(tip.textContent).not.toContain('`login`');
  });
});
