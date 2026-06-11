import { describe, it, expect } from 'vitest';
import { mergeTestSignals, type TestSignalPulseDto, type LiveTestSignal } from './testSignals';

function dto(over: Partial<TestSignalPulseDto> = {}): TestSignalPulseDto {
  return {
    windowMinutes: 3,
    buckets: [
      { at: '2026-06-11T12:00:00Z', pass: 1, fail: 0, error: 0 },
      { at: '2026-06-11T12:01:00Z', pass: 0, fail: 0, error: 0 },
      { at: '2026-06-11T12:02:00Z', pass: 2, fail: 1, error: 0 },
    ],
    totals: { pass: 3, fail: 1, error: 0, total: 4 },
    ...over,
  };
}

describe('mergeTestSignals', () => {
  it('returns a safe empty view for a null baseline', () => {
    const m = mergeTestSignals(null, []);
    expect(m.buckets).toEqual([]);
    expect(m.totals).toEqual({ pass: 0, fail: 0, error: 0, total: 0 });
    expect(m.greenPct).toBe(100); // empty window reads as green, not 0%
    expect(m.ratePerMin).toBe(0);
    expect(m.failing).toBe(0);
  });

  it('passes the baseline through untouched when there are no live signals', () => {
    const m = mergeTestSignals(dto(), []);
    expect(m.totals).toEqual({ pass: 3, fail: 1, error: 0, total: 4 });
    expect(m.failing).toBe(1);
    expect(m.greenPct).toBe(75); // 3 of 4
    expect(m.peak).toBe(3); // the 12:02 bucket (2 pass + 1 fail)
  });

  it('folds a live signal into its own minute bucket', () => {
    const live: LiveTestSignal[] = [
      { at: '2026-06-11T12:02:30Z', status: 'fail' }, // same minute as the last bucket
    ];
    const m = mergeTestSignals(dto(), live);
    const last = m.buckets[m.buckets.length - 1];
    expect(last.at).toBe('2026-06-11T12:02:00Z');
    expect(last.fail).toBe(2); // 1 baseline + 1 live
    expect(m.totals).toEqual({ pass: 3, fail: 2, error: 0, total: 5 });
    expect(m.failing).toBe(2);
  });

  it('extends the window when a live signal rolls into a new minute, dropping the stalest bucket', () => {
    const live: LiveTestSignal[] = [{ at: '2026-06-11T12:03:10Z', status: 'pass' }];
    const m = mergeTestSignals(dto(), live);
    // Width stays 3 (windowMinutes); the 12:00 bucket falls off the front.
    expect(m.buckets).toHaveLength(3);
    expect(m.buckets[0].at).toBe('2026-06-11T12:01:00Z');
    expect(m.buckets[m.buckets.length - 1].at).toBe('2026-06-11T12:03:00Z');
    // 12:00's single pass is dropped from totals; the new pass is added.
    expect(m.totals).toEqual({ pass: 3, fail: 1, error: 0, total: 4 });
  });

  it('ignores live signals older than the baseline window (already covered)', () => {
    const live: LiveTestSignal[] = [{ at: '2026-06-11T11:59:00Z', status: 'error' }];
    const m = mergeTestSignals(dto(), live);
    expect(m.totals).toEqual({ pass: 3, fail: 1, error: 0, total: 4 });
    expect(m.buckets).toHaveLength(3);
  });
});
