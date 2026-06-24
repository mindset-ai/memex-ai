// Unit tests for AcPill — the compact, hover-tooltip AC pill shared by AcPanel
// and DecisionAcStrip. UNTAGGED; pins the click affordance + the tooltip's
// state-dependent branches (no-tests / passing / failing / stale / clickHint).

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AcPill } from './AcPill';
import type {
  AcWithVerification,
  AcVerificationState,
  AcTestSnapshot,
} from '../api/client';

function snapshot(over: Partial<AcTestSnapshot> = {}): AcTestSnapshot {
  return {
    testIdentifier: over.testIdentifier ?? 'suite > case',
    latestStatus: over.latestStatus ?? 'pass',
    latestRunAt: over.latestRunAt ?? new Date().toISOString(),
    runCount: over.runCount ?? 1,
  };
}

function row(
  over: {
    seq?: number;
    statement?: string;
    kind?: 'scope' | 'implementation';
    verificationState?: AcVerificationState;
    tests?: AcTestSnapshot[];
    daysSinceLastRun?: number | null;
  } = {},
): AcWithVerification {
  return {
    ac: {
      id: 'ac-id',
      memexId: 'mx',
      briefId: 'doc-1',
      seq: over.seq ?? 3,
      kind: over.kind ?? 'scope',
      statement: over.statement ?? 'The login form rejects bad passwords',
      status: 'active',
      acceptedBy: null,
      acceptedAt: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
    canonicalRef: 'ns/mx/specs/spec-1/acs/ac-3',
    tests: over.tests ?? [],
    verificationState: over.verificationState ?? 'verified',
    daysSinceLastRun: over.daysSinceLastRun ?? null,
    parents: [],
  };
}

describe('AcPill', () => {
  it('renders the ac-N label and fires onClick', () => {
    const onClick = vi.fn();
    render(<AcPill row={row({ seq: 7 })} onClick={onClick} />);
    const btn = screen.getByRole('button', { name: /ac-7/ });
    expect(btn).toHaveClass('cursor-pointer');
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('is non-interactive (cursor-default) when no onClick is given', () => {
    render(<AcPill row={row()} />);
    expect(screen.getByRole('button')).toHaveClass('cursor-default');
  });

  it('shows the tooltip on hover with statement, kind, and state', () => {
    render(
      <AcPill
        row={row({ kind: 'implementation', verificationState: 'failing', statement: 'X holds' })}
      />,
    );
    const btn = screen.getByRole('button');
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.mouseEnter(btn);
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('X holds');
    expect(tip).toHaveTextContent('implementation');
    expect(tip).toHaveTextContent('failing');
    fireEvent.mouseLeave(btn);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('shows the "no test asserts this" branch when there are no tests', () => {
    render(<AcPill row={row({ tests: [], verificationState: 'untested' })} />);
    fireEvent.focus(screen.getByRole('button'));
    expect(screen.getByRole('tooltip')).toHaveTextContent(
      /No test in the codebase asserts this yet/,
    );
  });

  it('summarises passing and failing test counts (plural + failing branch)', () => {
    render(
      <AcPill
        row={row({
          tests: [
            snapshot({ latestStatus: 'pass' }),
            snapshot({ latestStatus: 'fail' }),
            snapshot({ latestStatus: 'error' }),
          ],
        })}
      />,
    );
    fireEvent.mouseEnter(screen.getByRole('button'));
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('3 tests');
    expect(tip).toHaveTextContent('1 passing');
    expect(tip).toHaveTextContent('2 failing');
    expect(tip).toHaveTextContent(/last run/);
  });

  it('uses the singular "test" label for a single test and hides the failing clause', () => {
    render(<AcPill row={row({ tests: [snapshot({ latestStatus: 'pass' })] })} />);
    fireEvent.mouseEnter(screen.getByRole('button'));
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('1 test ·');
    expect(tip).not.toHaveTextContent('failing');
  });

  it('shows a staleness line when daysSinceLastRun exceeds 7', () => {
    render(
      <AcPill
        row={row({
          tests: [snapshot()],
          verificationState: 'stale',
          daysSinceLastRun: 14,
        })}
      />,
    );
    fireEvent.mouseEnter(screen.getByRole('button'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('stale: 14d since last run');
  });

  it('renders the clickHint only when both clickHint and onClick are present', () => {
    const { rerender } = render(
      <AcPill row={row()} onClick={vi.fn()} clickHint="Jump to the AC tab" />,
    );
    fireEvent.mouseEnter(screen.getByRole('button'));
    expect(screen.getByRole('tooltip')).toHaveTextContent('Jump to the AC tab');

    // hint dropped when onClick is absent
    rerender(<AcPill row={row()} clickHint="Jump to the AC tab" />);
    fireEvent.mouseEnter(screen.getByRole('button'));
    expect(screen.getByRole('tooltip')).not.toHaveTextContent('Jump to the AC tab');
  });
});
