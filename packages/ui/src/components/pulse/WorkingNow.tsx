// WorkingNow — the "Working now" zone of the Pulse board (spec-122 ac-1).
//
// The present-tense TOP zone: ONE line per active worker, fed from the presence
// endpoint. A manager glancing at it sees which specs are being worked right now
// and by whom — plus how long since that spec last had a state-changing event
// (so a spec with a present worker but a long-quiet activity clock reads
// differently from one that's churning).
//
// PRESENTATIONAL. Presence rows + the spec resolvers + the per-spec
// last-activity map all arrive via props; the Pulse page owns the polling.

import { LiveDot } from './LiveDot';
import { TimeAgo } from './TimeAgo';
import { clientLabel } from './clientLabel';
import type { PresentRow } from './types';

export interface WorkingNowProps {
  /** Everyone "here" right now across the Memex (already merged + sorted). */
  present: PresentRow[];
  /** True until the first presence poll resolves. */
  loading?: boolean;
  /** Resolve a spec doc id → its `spec-N` handle (for the deep link / label). */
  specHandle?: (docId: string) => string | undefined;
  /** Resolve a spec doc id → its human title. */
  specTitle?: (docId: string) => string | undefined;
  /**
   * Resolve a spec doc id → the ISO time of that spec's most recent
   * state-changing activity, or undefined if it's had none in view. Drives the
   * "last moved <ago>" clock per active spec.
   */
  lastActivityAt?: (docId: string) => string | undefined;
  /**
   * spec-255 ac-5 — resolve a spec doc id → the present-tense narrative of its
   * most recent event ("wiring the mic prompt"), for the per-worker line.
   */
  lastNarrative?: (docId: string) => string | undefined;
}

/** spec-255 ac-5 — compact glyph for the surface a worker is on. */
function channelGlyph(channel: PresentRow['channel']): string {
  switch (channel) {
    case 'rest_ui':
      return 'web';
    case 'mcp':
      return 'MCP';
    case 'in_app_agent':
      return 'in-app';
    case 'server':
      return 'server';
    default:
      return channel;
  }
}

/** Display name for a present worker — their resolved name, else surface label. */
function workerName(row: PresentRow): string {
  if (row.actorName) return row.actorName;
  if (row.clientId) return clientLabel(row.channel, row.clientId);
  return 'Someone';
}

export function WorkingNow({
  present,
  loading = false,
  specHandle,
  specTitle,
  lastActivityAt,
  lastNarrative,
}: WorkingNowProps) {
  return (
    <section
      data-testid="working-now"
      className="flex-none rounded-lg border border-edge-subtle bg-surface/40 overflow-hidden mb-4"
    >
      <div className="flex items-center gap-2 px-3 py-2 text-xs text-secondary border-b border-edge-subtle">
        <LiveDot live={present.length > 0} size="sm" />
        <span className="font-medium text-primary">Working now</span>
        <span className="opacity-40">&middot;</span>
        <span>
          {present.length} {present.length === 1 ? 'worker' : 'workers'}
        </span>
      </div>

      {loading && present.length === 0 ? (
        <div className="px-3 py-3 text-xs text-muted" data-testid="working-now-loading">
          Checking who&rsquo;s here&hellip;
        </div>
      ) : present.length === 0 ? (
        <div className="px-3 py-3 text-xs text-muted" data-testid="working-now-empty">
          No one is actively working a spec right now.
        </div>
      ) : (
        <ul className="divide-y divide-edge-subtle/60">
          {present.map((row) => {
            const handle = specHandle?.(row.docId);
            const title = specTitle?.(row.docId);
            const lastAt = lastActivityAt?.(row.docId);
            const narrative = lastNarrative?.(row.docId);
            return (
              <li
                key={`${row.actorUserId}-${row.clientId}-${row.docId}`}
                data-testid="working-now-worker"
                data-doc-id={row.docId}
                className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-1.5 text-sm"
              >
                <LiveDot live size="sm" />
                <span className="font-medium text-primary">{workerName(row)}</span>
                <span className="text-muted">on</span>
                <span className="font-mono text-xs font-semibold text-accent">
                  {handle ?? 'a spec'}
                </span>
                {title ? <span className="text-muted text-xs">{title}</span> : null}
                {/* spec-255 ac-5 — the surface they're on (web / MCP / in-app). */}
                <span
                  data-testid="worker-channel"
                  className="font-mono text-[0.65rem] uppercase tracking-wide text-muted/80 border border-edge-subtle rounded px-1"
                >
                  {channelGlyph(row.channel)}
                </span>
                {/* How long since this worker's last beat. */}
                <span className="ml-auto text-xs text-muted tabular-nums" data-testid="worker-last-beat">
                  <TimeAgo value={row.lastSeenAt} />
                </span>
                {/* spec-255 ac-5 — present-tense line: what they're doing now.
                    NO per-person intensity sparkline here by design (a per-human
                    "how hard are they grinding" graph reads as surveillance). */}
                {narrative ? (
                  <span
                    className="basis-full pl-5 text-xs text-secondary italic"
                    data-testid="worker-line"
                  >
                    &ldquo;{narrative}&rdquo;
                  </span>
                ) : null}
                {/* How long since this spec last MOVED (state-changing event). */}
                {lastAt ? (
                  <span
                    className="basis-full pl-5 text-[0.7rem] text-muted/80"
                    data-testid="spec-last-activity"
                  >
                    last moved <TimeAgo value={lastAt} />
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
