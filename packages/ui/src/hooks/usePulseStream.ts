import { useEffect, useRef, useState, useCallback } from 'react';
import { useAuth } from '../components/AuthContext';
import { tenantBase, BASE_URL } from '../api/http';
import type {
  ActivityRow,
  ActorKind,
  ActivityChannel,
  PulseConnectionStatus,
} from '../components/pulse/types';

/**
 * usePulseStream — the live half of the Pulse (b-60) dashboard.
 *
 * Opens the per-Memex doc-events SSE stream with `?include=all` so EVERY action
 * (mutations AND the b-60 read actions viewed/searched/assessed/called) is
 * delivered, and surfaces each incoming `ChangeEvent` as a normalised
 * `ActivityRow` via the `onRow` callback. Also exposes the latest row and a
 * connection `status` for the "● Live" status line.
 *
 * Reuses the exact EventSource-over-fetch + exponential-backoff reconnect
 * pattern from `useDocChangeStream`, including the std-8 / doc-16 dec-4
 * reconnect-refetch contract: on every reconnect AFTER the first connect we
 * fire `onReconnect` so the consumer can re-pull history and close any gap that
 * opened during the disconnect.
 *
 * Liveness: the server emits a `keepalive` SSE event every 30s. We treat any
 * SSE frame (ready / keepalive / doc_change) as a heartbeat and flip status to
 * `'dead'` when none has arrived for >30s on an otherwise-open stream, so the
 * status line can show a stalled connection even before fetch notices the drop.
 */

const DEAD_AFTER_MS = 30_000;

// Channel → actorKind, mirroring the server's CHANNEL_TO_ACTOR_KIND map
// (services/activity-log.ts). Used when an SSE event arrives without enough
// info for the row's actorKind to be implied; channel is the source of truth.
const CHANNEL_TO_ACTOR_KIND: Record<ActivityChannel, ActorKind> = {
  rest_ui: 'human',
  mcp: 'mcp_agent',
  in_app_agent: 'in_app_agent',
  server: 'system',
};

// Shape of the bus ChangeEvent as it arrives JSON-encoded on the SSE `data:`
// line. Kept local + structural (not imported from the server package) so the
// admin build has no server dependency.
interface ChangeEventWire {
  memexId: string;
  docId?: string;
  userId?: string;
  // spec-122 dec-3/dec-5 (ac-4) — WHO performed the action and their resolved
  // display name. Distinct from `userId` (the /me fan-out target).
  actorUserId?: string;
  actorName?: string;
  entity: string;
  action: string;
  narrative?: string;
  clientId?: string;
  channel?: ActivityChannel;
  payload?: Record<string, unknown>;
}

let synthSeq = 0;

/**
 * Map a live `ChangeEvent` onto the shared `ActivityRow` shape so live and
 * historical (REST) rows are interchangeable in the UI. Mirrors the server's
 * `mapEventToRow` field-for-field, with a synthesised client-side id (the live
 * row has not yet been read back from the DB) and `createdAt` stamped to now.
 */
export function changeEventToRow(event: ChangeEventWire): ActivityRow {
  const channel: ActivityChannel = event.channel ?? 'server';
  const narrative =
    event.narrative && event.narrative.trim().length > 0
      ? event.narrative
      : `${event.action} ${event.entity}`;
  synthSeq += 1;
  return {
    id: `live-${Date.now()}-${synthSeq}`,
    memexId: event.memexId,
    briefId: event.docId ?? null,
    // Prefer the explicit actorUserId (spec-122 threading); fall back to the
    // legacy userId for events that predate it.
    actorUserId: event.actorUserId ?? event.userId ?? null,
    actorName: event.actorName ?? null,
    actorKind: CHANNEL_TO_ACTOR_KIND[channel],
    channel,
    clientId: event.clientId ?? null,
    entity: event.entity,
    action: event.action,
    narrative,
    payload: event.payload ?? null,
    createdAt: new Date().toISOString(),
  };
}

export interface UsePulseStreamOptions {
  /** Fired once per incoming live activity row. */
  onRow?: (row: ActivityRow) => void;
  /**
   * Fired when the stream RE-establishes after a drop (never on the first
   * connect). Per std-8 dec-4 the consumer should refetch history here to close
   * any gap that opened while disconnected.
   */
  onReconnect?: () => void;
}

export interface UsePulseStreamResult {
  /** The most recent live row, or null before the first event. */
  latest: ActivityRow | null;
  /** Live-connection health for the "● Live" status line. */
  status: PulseConnectionStatus;
}

export function usePulseStream(
  options: UsePulseStreamOptions = {},
): UsePulseStreamResult {
  const { token } = useAuth();

  const onRowRef = useRef(options.onRow);
  onRowRef.current = options.onRow;
  const onReconnectRef = useRef(options.onReconnect);
  onReconnectRef.current = options.onReconnect;

  const [latest, setLatest] = useState<ActivityRow | null>(null);
  const [status, setStatus] = useState<PulseConnectionStatus>('connecting');

  // Heartbeat tracking lives in refs so the watchdog interval can read the
  // freshest timestamp without re-subscribing.
  const lastBeatRef = useRef<number>(Date.now());
  const openRef = useRef(false);

  const markBeat = useCallback(() => {
    lastBeatRef.current = Date.now();
    if (openRef.current) setStatus('connected');
  }, []);

  useEffect(() => {
    let abortController = new AbortController();
    let retryDelay = 1000;
    let mounted = true;
    // doc-16 dec-4: refetch on every reconnect AFTER the first connect. The
    // first connect is covered by the consumer's initial history fetch.
    let hasConnectedBefore = false;

    // Watchdog: if no heartbeat for >30s while the stream is nominally open,
    // surface 'dead'. The server keepalive cadence is 30s, so a missed beat is
    // a strong signal the stream has silently stalled (proxy/Cloud Run drop).
    const watchdog = setInterval(() => {
      if (!mounted) return;
      if (openRef.current && Date.now() - lastBeatRef.current > DEAD_AFTER_MS) {
        setStatus('dead');
      }
    }, 5_000);

    async function connect() {
      // t-18 of doc-15 (F.3): doc-events live under the tenancy-scoped path
      // prefix. tenantBase() returns null on the bare/apex domain — fall back
      // to the flat surface, which still works for single-membership callers
      // via std-5 inference. Mirrors useDocChangeStream.
      const base = tenantBase() ?? BASE_URL;
      // Pulse wants EVERY action, not just mutations — `?include=all` opens the
      // full firehose (reads + writes). See doc-events.ts resolveIncludeActions.
      const url = `${base}/docs/events?include=all`;

      const headers: Record<string, string> = {};
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      try {
        const res = await fetch(url, {
          headers,
          signal: abortController.signal,
        });

        if (!res.ok) {
          throw new Error(`SSE connection failed: ${res.status}`);
        }

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        retryDelay = 1000; // Reset on successful connection
        openRef.current = true;
        markBeat(); // connection itself counts as a heartbeat

        // Reconnect-refetch (std-8 dec-4): only on reconnects, not first connect.
        if (hasConnectedBefore && mounted) {
          onReconnectRef.current?.();
        }
        hasConnectedBefore = true;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          const parts = buffer.split('\n\n');
          buffer = parts.pop() ?? '';

          for (const part of parts) {
            if (!part.trim()) continue;

            let eventType = '';
            let dataLine = '';
            for (const line of part.split('\n')) {
              if (line.startsWith('event:')) {
                eventType = line.slice(6).trim();
              } else if (line.startsWith('data:')) {
                dataLine = line.slice(5).trim();
              }
            }

            // Any frame is a heartbeat for liveness purposes.
            if (mounted) markBeat();

            if (eventType === 'doc_change' && dataLine && mounted) {
              try {
                const parsed = JSON.parse(dataLine) as ChangeEventWire;
                const row = changeEventToRow(parsed);
                setLatest(row);
                onRowRef.current?.(row);
              } catch {
                // Malformed frame — skip it; the stream stays healthy.
              }
            }
          }
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
      }

      // Stream ended / errored: mark closed and reconnect with backoff.
      openRef.current = false;
      if (mounted) {
        setStatus('reconnecting');
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        retryDelay = Math.min(retryDelay * 2, 30_000);
        if (mounted) connect();
      }
    }

    setStatus('connecting');
    connect();

    return () => {
      mounted = false;
      openRef.current = false;
      clearInterval(watchdog);
      abortController.abort();
    };
  }, [token, markBeat]);

  return { latest, status };
}
