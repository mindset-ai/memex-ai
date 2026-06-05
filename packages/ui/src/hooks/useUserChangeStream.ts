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
 */
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

  const debouncedCallback = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      onEventRef.current();
    }, 200);
  }, []);

  useEffect(() => {
    let abortController = new AbortController();
    let retryDelay = 1000;
    let mounted = true;
    // doc-16 dec-4: every SSE consumer triggers a refetch on reconnect. The
    // first connect after mount does NOT fire — the page's initial fetch
    // covers that case — but every subsequent reconnect does.
    let hasConnectedBefore = false;

    async function connect() {
      // Pulse (b-60) t-11: state the action contract explicitly. This hook only
      // wants mutations (created/updated/deleted), matching the server default,
      // so behaviour is unchanged — we just no longer rely on the implicit default.
      const url = `${BASE_URL}/me/events?include=mutations`;
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

        retryDelay = 1000;

        if (hasConnectedBefore) {
          debouncedCallback();
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

            if (eventType === 'user_change' && mounted) {
              if (filterRef.current && dataLine) {
                try {
                  const parsed = JSON.parse(dataLine) as { entity?: string };
                  if (parsed.entity && !filterRef.current.includes(parsed.entity)) {
                    continue;
                  }
                } catch {
                  // Parse failure: be permissive and fire anyway.
                }
              }
              debouncedCallback();
            }
          }
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
      }

      if (mounted) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        retryDelay = Math.min(retryDelay * 2, 30_000);
        if (mounted) connect();
      }
    }

    connect();

    return () => {
      mounted = false;
      abortController.abort();
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [token, debouncedCallback]);
}
