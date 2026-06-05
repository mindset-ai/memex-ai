import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { LiveDot } from '../LiveDot';
import type { AttentionSlice } from './useNeedsAttention';

/**
 * OpenQuestionsTile — the "Open questions" tray tile (Pulse b-60, Wave 2).
 * Surfaces comments with `comment_type='question'` that are still unresolved.
 * Presentational: count badge + most-recent 2-3 as deep-links + "view all".
 *
 * The count badge uses <LiveDot/> and pulses briefly when the count CHANGES.
 */
export interface OpenQuestionsTileProps {
  /** The open-questions slice from useNeedsAttention. */
  data: AttentionSlice;
  /** "view all" deep-link target. Default: the inbox view. */
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

export function OpenQuestionsTile({
  data,
  viewAllHref = 'inbox',
}: OpenQuestionsTileProps) {
  const pulsing = useCountPulse(data.count);

  return (
    <section
      className="rounded-lg border border-edge bg-card-hover/40 p-3"
      data-testid="tray-tile-questions"
      aria-label="Open questions"
    >
      <header className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          <LiveDot
            live={pulsing}
            size="sm"
            title={pulsing ? 'Count changed' : undefined}
          />
          <h3 className="text-xs font-semibold uppercase tracking-wider text-secondary">
            Open questions
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
          No open questions.
        </p>
      ) : (
        <ul className="space-y-1">
          {data.items.map((item) => (
            <li key={item.id} className="text-xs leading-snug">
              <Link
                to={item.href ?? viewAllHref}
                className="group flex items-baseline gap-1.5 hover:underline"
                title={item.title}
              >
                {item.specHandle && (
                  <span className="font-mono text-muted shrink-0">
                    {item.specHandle}
                  </span>
                )}
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
          View all →
        </Link>
      )}
    </section>
  );
}
