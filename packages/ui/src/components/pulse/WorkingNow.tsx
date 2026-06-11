// WorkingNow — the "Working now" zone of the Pulse board.
//
// ONE line per worker INVOLVED in the last ~5min (presence ∪ recent activity —
// spec-255 int feedback), so reading a long spec doesn't drop you the instant
// your heartbeat lapses. The dot grades freshness: a pulsing green dot while
// active (live), a static grey dot once idle (still listed, retained 5min).
//
// PRESENTATIONAL. The derived workers + spec resolvers arrive via props; the
// Pulse page owns the polling + derivation.

import { Link } from 'react-router-dom';
import { LiveDot } from './LiveDot';
import { TimeAgo } from './TimeAgo';
import { clientLabel } from './clientLabel';
import type { ActivityChannel } from './types';
import type { Worker } from './pulseDerive';

export interface WorkingNowProps {
  /** Everyone involved across the Memex in the last ~5min, freshness-graded. */
  workers: Worker[];
  /** True until the first poll resolves. */
  loading?: boolean;
  specHandle?: (docId: string) => string | undefined;
  specTitle?: (docId: string) => string | undefined;
  /** Resolve a `spec-N` handle → its href, so the handle renders as a link. */
  specHref?: (handle: string) => string;
  /** docId → ISO of that spec's most recent state-changing activity. */
  lastActivityAt?: (docId: string) => string | undefined;
  /** docId → present-tense narrative of its most recent event. */
  lastNarrative?: (docId: string) => string | undefined;
}

/** Compact glyph for the surface a worker is on. */
function channelGlyph(channel: ActivityChannel): string {
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

function workerName(w: Worker): string {
  if (w.actorName) return w.actorName;
  // An agent with no resolved name shows "Claude Code" / "In-app agent" — never
  // the opaque "MCP · <id>" client label (spec-255 int feedback): a worker is
  // always a real person or that person's agent.
  if (w.actorKind === 'mcp_agent') return 'Claude Code';
  if (w.actorKind === 'in_app_agent') return 'In-app agent';
  if (w.clientId) return clientLabel(w.channel, w.clientId);
  return 'Someone';
}

export function WorkingNow({
  workers,
  loading = false,
  specHandle,
  specTitle,
  specHref,
  lastActivityAt,
  lastNarrative,
}: WorkingNowProps) {
  const anyLive = workers.some((w) => w.freshness === 'live');
  return (
    <section
      data-testid="working-now"
      className="flex-none rounded-lg border border-edge-subtle bg-surface/40 overflow-hidden mb-4"
    >
      <div
        className="flex items-center gap-2 px-3 py-2 text-xs text-secondary border-b border-edge-subtle cursor-help"
        title="Working now — everyone who's been active on a spec in the last 5 minutes (a live heartbeat or recent work). A pulsing green dot is active right now; a grey dot is idle but still here."
      >
        <LiveDot live={anyLive} size="sm" />
        <span className="font-medium text-primary">Working now</span>
        <span className="opacity-40">&middot;</span>
        <span>
          {workers.length} {workers.length === 1 ? 'worker' : 'workers'}
        </span>
      </div>

      {loading && workers.length === 0 ? (
        <div className="px-3 py-3 text-xs text-muted" data-testid="working-now-loading">
          Checking who&rsquo;s here&hellip;
        </div>
      ) : workers.length === 0 ? (
        <div className="px-3 py-3 text-xs text-muted" data-testid="working-now-empty">
          No one has worked a spec in the last few minutes.
        </div>
      ) : (
        <ul className="divide-y divide-edge-subtle/60">
          {workers.map((w) => {
            const handle = w.docId ? specHandle?.(w.docId) : undefined;
            const title = w.docId ? specTitle?.(w.docId) : undefined;
            const lastAt = w.docId ? lastActivityAt?.(w.docId) : undefined;
            const narrative = w.docId ? lastNarrative?.(w.docId) : undefined;
            return (
              <li
                key={w.key}
                data-testid="working-now-worker"
                data-doc-id={w.docId ?? undefined}
                data-freshness={w.freshness}
                className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-1.5 text-sm"
              >
                {/* live = pulsing green; idle = static grey (still here, just quiet). */}
                {w.freshness === 'live' ? (
                  <LiveDot live size="sm" />
                ) : (
                  <span
                    data-testid="worker-idle-dot"
                    title="idle"
                    className="inline-block h-2 w-2 rounded-full bg-zinc-400/70"
                  />
                )}
                <span className="font-medium text-primary">{workerName(w)}</span>
                <span className="text-muted">on</span>
                {handle && specHref ? (
                  <Link to={specHref(handle)} className="font-mono text-xs font-semibold text-accent hover:underline">
                    {handle}
                  </Link>
                ) : (
                  <span className="font-mono text-xs font-semibold text-accent">{handle ?? 'a spec'}</span>
                )}
                {title ? <span className="text-muted text-xs">{title}</span> : null}
                <span
                  data-testid="worker-channel"
                  className="font-mono text-[0.65rem] uppercase tracking-wide text-muted/80 border border-edge-subtle rounded px-1"
                >
                  {channelGlyph(w.channel)}
                </span>
                <span className="ml-auto text-xs text-muted tabular-nums" data-testid="worker-last-beat">
                  <TimeAgo value={new Date(w.lastSeenMs).toISOString()} />
                </span>
                {narrative ? (
                  <span className="basis-full pl-5 text-xs text-secondary italic" data-testid="worker-line">
                    &ldquo;{narrative}&rdquo;
                  </span>
                ) : null}
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
