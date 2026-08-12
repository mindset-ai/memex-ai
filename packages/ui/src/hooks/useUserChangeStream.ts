import { useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../components/AuthContext';
import { BASE_URL } from '../api/http';

/**
 * Subscribes to real-time user-scoped change events via SSE.
 *
 * Mirrors `useDocChangeStream` but listens on /api/me/events — the per-user
 * channel. Used by pages backed by user-scoped resources (mcp_tokens today;
 * future: user-side membership / consent / namespace events) so the UI reacts
 * across tabs and devices.
 *
 * Per std-8 dec-4 the hook MUST trigger a refetch when the SSE stream re-
 * establishes after the initial connection, even before any event arrives on
 * the new connection. The `entityFilter` param lets callers narrow which
 * entity types trigger the callback — e.g. SettingsTokens only cares about
 * `mcp_token` events.
 *
 * Connection sharing: every call site here subscribes to the SAME stream scope
 * — there is exactly one per-user channel, `/api/me/events` — so N call sites
 * used to mean N never-closing streaming fetches to one origin. Under HTTP/1.1
 * (local dev and the e2e run go through the Vite proxy) the browser caps
 * concurrent connections per origin at 6, so the app saturated the pool and
 * starved every subsequent request: API fetches AND full-document navigations
 * alike queued forever with no error and no timeout. `useDocChangeStream` was
 * given exactly this fix in spec-118; this hook — its stated mirror — never
 * inherited it, and quietly crossed the limit as call sites accumulated
 * (AuthContext + DesktopMcpStatusSync are app-global, and Settings →
 * Integrations mounts four more at once). Subscribers now multiplex onto ONE
 * shared connection per `(url, token)` scope, so the whole app holds one
 * user-channel stream instead of ten.
 *
 * The `entityFilter` stays a SUBSCRIBER concern, not a connection one: the
 * shared reader dispatches each event's entity to every subscriber and each
 * decides whether it cares. A reconnect dispatches `null`, which every
 * subscriber treats as "refetch regardless of filter" — preserving dec-4.
 */

// ── Shared SSE connection registry ──────────────────────────────────────────
// Keyed by `${url}::${token}` so every subscriber on the same stream scope
// shares one underlying streaming fetch. Ref-counted: the connection opens with
// the first subscriber and aborts when the last one leaves.

/**
 * Called with the event's `entity` value, or `null` to mean "unconditional" —
 * either a reconnect (dec-4) or an event whose entity could not be read, which
 * this hook has always treated permissively.
 */
type Subscriber = (entity: string | null) => void;

interface SharedConn {
  subscribers: Set<Subscriber>;
  abort: AbortController;
  closed: boolean;
}

const connections = new Map<string, SharedConn>();

function notify(conn: SharedConn, entity: string | null): void {
  // Snapshot so a subscriber that unsubscribes during dispatch can't mutate the
  // set mid-iteration.
  for (const sub of Array.from(conn.subscribers)) {
    sub(entity);
  }
}

function runConnection(key: string, url: string, headers: Record<string, string>): void {
  const conn = connections.get(key);
  if (!conn) return;

  let retryDelay = 1000;
  // doc-16 dec-4: every SSE consumer MUST refetch when the stream re-establishes,
  // even before any event arrives on the new connection. The FIRST connect does
  // NOT fire (each consumer's own initial fetch covers that); every subsequent
  // reconnect notifies all current subscribers.
  let hasConnectedBefore = false;

  async function connect(): Promise<void> {
    try {
      const res = await fetch(url, { headers, signal: conn!.abort.signal });
      if (!res.ok) throw new Error(`SSE connection failed: ${res.status}`);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      retryDelay = 1000; // Reset on successful connection

      if (hasConnectedBefore) notify(conn!, null);
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

          if (eventType !== 'user_change' || conn!.closed) continue;

          // `null` = "no entity to filter on" → every subscriber fires. That is
          // the pre-existing permissive contract for an absent or unparseable
          // payload; keep it, so a malformed event can never silently drop a
          // refetch.
          let entity: string | null = null;
          if (dataLine) {
            try {
              entity = (JSON.parse(dataLine) as { entity?: string }).entity ?? null;
            } catch {
              entity = null;
            }
          }
          notify(conn!, entity);
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
    }

    // Reconnect with exponential backoff while subscribers remain.
    if (!conn!.closed) {
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      retryDelay = Math.min(retryDelay * 2, 30_000);
      if (!conn!.closed) connect();
    }
  }

  connect();
}

function acquire(
  key: string,
  url: string,
  headers: Record<string, string>,
  sub: Subscriber,
): void {
  let conn = connections.get(key);
  if (!conn) {
    conn = { subscribers: new Set(), abort: new AbortController(), closed: false };
    connections.set(key, conn);
    conn.subscribers.add(sub);
    runConnection(key, url, headers);
    return;
  }
  conn.subscribers.add(sub);
}

function release(key: string, sub: Subscriber): void {
  const conn = connections.get(key);
  if (!conn) return;
  conn.subscribers.delete(sub);
  if (conn.subscribers.size === 0) {
    conn.closed = true;
    conn.abort.abort();
    connections.delete(key);
  }
}

export function useUserChangeStream(
  onEvent: () => void,
  entityFilter?: ReadonlyArray<string>
) {
  const { token } = useAuth();
  return useUserChangeStreamWithToken(token, onEvent, entityFilter);
}

/**
 * Lower-level variant that takes the auth token explicitly. AuthContext uses
 * this to avoid the circular-dep / Provider-mount race that would happen if
 * the context itself called `useAuth()`.
 */
export function useUserChangeStreamWithToken(
  token: string | null,
  onEvent: () => void,
  entityFilter?: ReadonlyArray<string>
) {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const filterRef = useRef(entityFilter);
  filterRef.current = entityFilter;

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stable identity: this is what the shared connection holds, so it must not
  // change between renders or the subscriber would churn on every render.
  const subscriber = useCallback((entity: string | null) => {
    // `null` = reconnect or unreadable payload → always refetch.
    if (entity !== null && filterRef.current && !filterRef.current.includes(entity)) {
      return;
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      onEventRef.current();
    }, 200);
  }, []);

  useEffect(() => {
    // Pulse (b-60) t-11: state the action contract explicitly. This hook only
    // wants mutations (created/updated/deleted), matching the server default,
    // so behaviour is unchanged — we just no longer rely on the implicit default.
    const url = `${BASE_URL}/me/events?include=mutations`;
    const headers: Record<string, string> = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const key = `${url}::${token ?? ''}`;
    acquire(key, url, headers, subscriber);

    return () => {
      release(key, subscriber);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [token, subscriber]);
}
