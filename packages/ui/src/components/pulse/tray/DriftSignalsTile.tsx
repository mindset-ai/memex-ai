import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { LiveDot } from '../LiveDot';
import type { AttentionSlice } from './useNeedsAttention';

/**
 * DriftSignalsTile — the "Drift signals" tray tile (Pulse b-60, Wave 2).
 * Shows a count of open drift findings + the affected Standards handles + a
 * "view in Standards →" deep-link. Presentational.
 *
 * The count badge uses <LiveDot/> and pulses briefly when the count CHANGES.
 *
 * NOTE on the deep-link target: the drift TRIAGE surface is owned by a future
 * sibling Spec (Standards drift). Until that lands, "view all" points at the
 * existing Drift Inbox route (`drift`) as a placeholder. Per-Standard items
 * deep-link to `/standards/:handle`.
 */
export interface DriftSignalsTileProps {
  /** The drift slice from useNeedsAttention (count = open findings; items =
   *  affected Standards). */
  data: AttentionSlice;
  /**
   * "view all" deep-link target.
   * TODO repoint when Standards drift Spec lands — defaults to the existing
   * Drift Inbox route as a placeholder.
   */
  viewAllHref?: string;
}

const PULSE_MS = 2000;

function useCountPulse(count: number): boolean {
  const prev = useRef(count);
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (prev.current !== count) {
      prev.current = count;
      setLive(true);
      const id = window.setTimeout(() => setLive(false), PULSE_MS);
      return () => window.clearTimeout(id);
    }
  }, [count]);

  return live;
}

export function DriftSignalsTile({
  // TODO repoint when Standards drift Spec lands — `drift` is the current
  // Drift Inbox route; the dedicated triage surface will replace it.
  data,
  viewAllHref = 'drift',
}: DriftSignalsTileProps) {
  const pulsing = useCountPulse(data.count);

  return (
    <section
      className="rounded-lg border border-edge bg-card-hover/40 p-3"
      data-testid="tray-tile-drift"
      aria-label="Drift signals"
    >
      <header className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <LiveDot
            live={pulsing}
            size="sm"
            title={pulsing ? 'Count changed' : undefined}
          />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-secondary">
            Drift signals
          </h3>
        </div>
        {data.count > 0 && (
          <span
            className="inline-flex items-center justify-center min-w-[1.25rem] px-1.5 h-5 rounded-full text-xs font-medium bg-surface text-primary border border-edge"
            data-testid="tray-count"
          >
            {data.count}
          </span>
        )}
      </header>

      {data.items.length === 0 ? (
        <p className="text-xs text-muted" data-testid="tray-tile-empty">
          No drift detected.
        </p>
      ) : (
        <ul className="space-y-1">
          {data.items.map((item) => (
            <li key={item.id} className="text-xs leading-snug">
              <Link
                to={item.href ?? `/standards/${item.handle}`}
                className="group flex items-baseline gap-1.5 hover:underline"
                title={item.title}
              >
                <span className="font-mono text-accent shrink-0">
                  {item.handle}
                </span>
                <span className="text-secondary truncate">{item.title}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {data.count > 0 && (
        <Link
          to={viewAllHref}
          className="mt-2 inline-block text-xs text-accent hover:text-accent-hover hover:underline"
        >
          View in Standards →
        </Link>
      )}
    </section>
  );
}
