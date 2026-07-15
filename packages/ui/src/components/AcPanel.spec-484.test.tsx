// spec-484 t-3 / dec-2 — AcPanel statement renders inline markdown.
//
// The unified AC list printed `r.ac.statement` as plain text, so authored
// `code`/`**bold**` showed as literal syntax. This pins that the statement now
// routes through the shared markdown renderer in INLINE mode: `code` → <code>,
// `**bold**` → <strong>, with no <p>/list wrapper disturbing the row layout.

import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AcPanel } from './AcPanel';
import {
  fetchAcsForBrief,
  fetchAcAlignmentHistory,
  type AcWithVerification,
} from '../api/client';
import { tagAc } from '@memex-ai-ac/vitest';

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-484/acs/ac-${n}`;

vi.mock('../api/client', async () => {
  const actual = await vi.importActual<typeof import('../api/client')>('../api/client');
  return {
    ...actual,
    fetchAcsForBrief: vi.fn(),
    fetchAcAlignmentHistory: vi.fn(),
    fetchAcTestMatrix: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('./ChatContext', () => ({
  useChat: () => ({ addContextChip: vi.fn() }),
}));

beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
  vi.clearAllMocks();
});

function makeAc(): AcWithVerification {
  return {
    ac: {
      id: 'ac-1',
      memexId: 'memex-1',
      briefId: 'spec-1',
      seq: 1,
      kind: 'implementation',
      statement: 'The `login` form rejects **bad** passwords',
      status: 'active',
      acceptedBy: null,
      acceptedAt: null,
      createdAt: '2026-05-01T00:00:00Z',
      updatedAt: '2026-05-01T00:00:00Z',
    },
    canonicalRef: 'ns/m/specs/spec-484/acs/ac-1',
    tests: [],
    verificationState: 'untested',
    daysSinceLastRun: 0,
    parents: [],
  } as AcWithVerification;
}

describe('spec-484: AcPanel statement renders inline markdown', () => {
  it('ac-8 / ac-13: the AC statement routes through the markdown renderer (code + strong)', async () => {
    tagAc(AC(8));
    tagAc(AC(13));
    vi.mocked(fetchAcsForBrief).mockResolvedValue([makeAc()]);
    vi.mocked(fetchAcAlignmentHistory).mockResolvedValue([]);

    render(<AcPanel docId="doc-1" />);

    const list = await screen.findByTestId('ac-unified-list');
    await waitFor(() => expect(list.querySelector('code')).not.toBeNull());
    expect(list.querySelector('code')?.textContent).toBe('login');
    expect(list.querySelector('strong')?.textContent).toBe('bad');
    expect(list.textContent).not.toContain('`login`');
  });
});
