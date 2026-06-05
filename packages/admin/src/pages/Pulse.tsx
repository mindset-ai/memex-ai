// Pulse — the activity dashboard (b-60, Wave 2; assembled per dec-8).
//
// INTEGRATION page: it owns no presentation of its own beyond layout — every
// piece (the live stream, the activity history, the feed, the tray, the
// filters) is a pre-built hook/component this page wires together.
//
// What this page is responsible for:
//   - Scope (dec-7): a [Just me | Everyone] toggle, default 'me'. 'me' pins the
//     history/stream filter to the current user's id; 'everyone' lifts it.
//   - Per-Spec filter (dec-9): reflected through `?spec=spec-N` in the URL so it
//     survives reload / is linkable. The selected spec's id is passed to both
//     usePulseHistory and NeedsAttentionTray.
//   - Active-client chips (dec-7): under 'me' scope only, one chip per client
//     the user has driven in the last ~10min; clicking toggles a clientId
//     filter on the feed.
//   - Live + history merge: usePulseStream pushes live rows (synthesised `live-`
//     ids); we accumulate them, FILTER them by the active scope/spec/client
//     (the stream is the whole-Memex firehose), and hand the merged set to
//     ActivityFeed, which sorts + de-dupes.
//
// Visual polish + the §2 empty/loading/disconnected states live in the
// presentational children (ActivityFeed, NeedsAttentionTray + tiles); this page
// stays a thin wiring layer and just hands them the rows/status/loading flags.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../components/AuthContext';
import { fetchDocs } from '../api/client';
import type { DocSummary } from '../api/types';
import { PageHeader } from '../components/PageHeader';
import { LiveDot } from '../components/pulse/LiveDot';
import { ActivityFeed } from '../components/pulse/ActivityFeed';
import { NeedsAttentionTray } from '../components/pulse/NeedsAttentionTray';
import { SpecPicker, type SpecPickerSpec } from '../components/pulse/SpecPicker';
import { ScopeToggle, type PulseScope } from '../components/pulse/ScopeToggle';
import { ClientChip } from '../components/pulse/ClientChip';
import { usePulseHistory } from '../hooks/usePulseHistory';
import { usePulseStream } from '../hooks/usePulseStream';
import type { ActivityRow, PulseConnectionStatus } from '../components/pulse/types';

// A client is shown as an active chip if it produced an event in this window…
const ACTIVE_CLIENT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
// …and its dot "breathes" (live) if it produced one this recently.
const CLIENT_LIVE_WINDOW_MS = 30 * 1000; // 30 seconds
// Cap on the in-memory live-row buffer so a long-lived session doesn't grow
// unbounded. The feed only ever needs the most recent live rows; older ones
// have long since been superseded by paged-in history.
const LIVE_BUFFER_CAP = 200;
const ONE_HOUR_MS = 60 * 60 * 1000;

function rowMs(row: ActivityRow): number {
  return new Date(row.createdAt).getTime();
}

// dec-7: a client chip shows a human label by channel — never the raw clientId
// (an opaque session hash / MCP token id / conversation id). The clientId is
// still the filter key (chip toggle), just not the display text.
function clientLabel(channel: ActivityRow['channel'] | undefined, clientId: string): string {
  switch (channel) {
    case 'server':
      return 'System';
    case 'in_app_agent':
      return 'In-app agent';
    case 'mcp':
      // The MCP token's name isn't surfaced client-side yet (Wave-3 follow-up);
      // fall back to a short, readable prefix rather than the full token id.
      return `MCP · ${clientId.slice(0, 6)}`;
    case 'rest_ui':
      return 'This browser';
    default:
      return `Client · ${clientId.slice(0, 6)}`;
  }
}

export function Pulse() {
  const { session } = useAuth();
  const { namespace, memex } = useParams<{ namespace: string; memex: string }>();
  const currentUserId = session?.user.id ?? null;

  // ── Memex display name for the header title (mirrors PageHeader's lookup). ──
  const memexName = useMemo(() => {
    const m = session?.memberships.find(
      (mem) => mem.slug === namespace && (mem.memexSlug ?? null) === (memex ?? null),
    );
    return m?.memexName ?? m?.name ?? null;
  }, [session, namespace, memex]);

  // ── Scope (dec-7): default 'me'. ────────────────────────────────────────────
  const [scope, setScope] = useState<PulseScope>('me');

  // ── Per-Spec filter (dec-9), reflected through `?spec=spec-N`. ───────────────
  const [searchParams, setSearchParams] = useSearchParams();
  const specHandle = searchParams.get('spec'); // a `spec-N` handle, or null
  const setSpecHandle = useCallback(
    (handle: string | null) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (handle) next.set('spec', handle);
          else next.delete('spec');
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  // ── Spec list for the picker (reuse SpecList's fetchDocs('spec') path). ──
  const [specDocs, setSpecDocs] = useState<DocSummary[]>([]);
  const [specsLoading, setSpecsLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setSpecsLoading(true);
    fetchDocs('spec')
      .then((docs) => {
        if (!cancelled) setSpecDocs(docs);
      })
      .catch(() => {
        // Non-fatal: the picker just shows "No Specs". Errors here shouldn't
        // take down the feed, which is the page's primary surface.
        if (!cancelled) setSpecDocs([]);
      })
      .finally(() => {
        if (!cancelled) setSpecsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const pickerSpecs: SpecPickerSpec[] = useMemo(
    () => specDocs.map((d) => ({ handle: d.handle, title: d.title })),
    [specDocs],
  );

  // Resolve a Spec handle → its title so feed rows read "viewing spec-2 Pulse …"
  // rather than the bare handle. Sourced from the same Spec list the picker
  // uses; unknown handles (e.g. an archived Spec) resolve to undefined and the
  // row just shows the handle.
  const specTitle = useCallback(
    (handle: string): string | undefined => specDocs.find((d) => d.handle === handle)?.title,
    [specDocs],
  );

  // Resolve the `?spec=` handle → the spec record, for its id (history/tray
  // want a stable id; the history endpoint accepts a handle too, but the tray
  // wants the same value, so resolve once here).
  const selectedSpec = useMemo(
    () => specDocs.find((d) => d.handle === specHandle) ?? null,
    [specDocs, specHandle],
  );
  // Fall back to the raw handle if the spec list hasn't loaded yet — the
  // history endpoint resolves either a UUID or a `spec-N` handle (see
  // PulseHistoryFilters.specId), so the feed still narrows during the gap.
  const specId = selectedSpec?.id ?? specHandle ?? undefined;

  // ── Active-client filter (dec-7). Only meaningful under 'me' scope. ─────────
  const [clientId, setClientId] = useState<string | null>(null);
  // Clearing scope away from 'me' clears any client filter — chips don't render
  // under 'everyone', so a lingering filter would be invisible-but-active.
  useEffect(() => {
    if (scope !== 'me') setClientId(null);
  }, [scope]);

  // ── History filters derived from scope/spec/client. The hook's `briefId`
  // prop is the legacy name that we feed `specId` into — the underlying server
  // param hasn't been renamed yet. ────────────────────────────────────────────
  const actorUserId = scope === 'me' ? currentUserId ?? undefined : undefined;
  const history = usePulseHistory({
    actorUserId,
    briefId: specId,
    clientId: clientId ?? undefined,
  });
  const { rows: historyRows, loading, hasMore, loadOlder, refresh } = history;

  // ── Live rows from the stream. The stream is the whole-Memex firehose, so we
  // accumulate then filter client-side to match the active scope/spec/client. ─
  const [liveRows, setLiveRows] = useState<ActivityRow[]>([]);
  // Resolve the selected spec's id inside the onRow callback without making the
  // callback identity depend on it (the stream re-subscribes on identity change).
  const selectedSpecIdRef = useRef<string | null>(null);
  selectedSpecIdRef.current = selectedSpec?.id ?? null;

  const handleRow = useCallback((row: ActivityRow) => {
    setLiveRows((prev) => {
      const next = [row, ...prev];
      return next.length > LIVE_BUFFER_CAP ? next.slice(0, LIVE_BUFFER_CAP) : next;
    });
  }, []);

  const { status } = usePulseStream({ onRow: handleRow, onReconnect: refresh });

  // Filter the accumulated live rows by the active scope/spec/client. Live rows
  // carry the same fields as history rows (changeEventToRow normalises them), so
  // we apply the same predicate the server would for the history query.
  const filteredLiveRows = useMemo(() => {
    const wantSpecId = selectedSpec?.id ?? null;
    return liveRows.filter((row) => {
      if (scope === 'me') {
        if (!currentUserId || row.actorUserId !== currentUserId) return false;
        if (clientId && row.clientId !== clientId) return false;
      }
      // dec-9: when a spec is selected, only rows touching it. We can only
      // match on id here (live rows carry briefId, not the handle); if the
      // spec list hasn't resolved yet we keep the rows rather than hide them.
      if (wantSpecId && row.briefId !== wantSpecId) return false;
      return true;
    });
  }, [liveRows, scope, currentUserId, clientId, selectedSpec]);

  // Merge live + history. ActivityFeed sorts newest-first and de-dupes by id, so
  // a live row that later arrives as a persisted history row is fine — they have
  // different ids (live-… vs the DB id) and the feed collapses bursts; the
  // momentary duplicate ages out as the live buffer rolls over on refresh.
  const mergedRows = useMemo(
    () => [...filteredLiveRows, ...historyRows],
    [filteredLiveRows, historyRows],
  );

  // On any filter change the history hook refetches; drop the now-mismatched
  // live buffer so stale-scope live rows don't linger past a scope/spec switch.
  useEffect(() => {
    setLiveRows([]);
  }, [scope, specId, clientId]);

  // ── eventsLastHour for the feed status line, from the merged set. ───────────
  const eventsLastHour = useMemo(() => {
    const cutoff = Date.now() - ONE_HOUR_MS;
    return mergedRows.filter((r) => rowMs(r) >= cutoff).length;
  }, [mergedRows]);

  // ── Active-client chips (dec-7): distinct clientIds the *current user* drove
  // in the last ~10min, derived from the merged rows. Only rendered under 'me'. ─
  const activeClients = useMemo(() => {
    if (scope !== 'me' || !currentUserId) return [];
    const now = Date.now();
    const seen = new Map<string, { lastMs: number; channel: ActivityRow['channel'] }>();
    for (const row of mergedRows) {
      if (row.actorUserId !== currentUserId) continue;
      if (!row.clientId) continue;
      const t = rowMs(row);
      if (now - t > ACTIVE_CLIENT_WINDOW_MS) continue;
      const existing = seen.get(row.clientId);
      if (!existing || t > existing.lastMs) seen.set(row.clientId, { lastMs: t, channel: row.channel });
    }
    return [...seen.entries()]
      .map(([id, { lastMs, channel }]) => ({
        id,
        label: clientLabel(channel, id),
        live: now - lastMs < CLIENT_LIVE_WINDOW_MS,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [mergedRows, scope, currentUserId]);

  const toggleClient = useCallback((id: string) => {
    setClientId((prev) => (prev === id ? null : id));
  }, []);

  const headerTitle = memexName ? `Pulse · ${memexName}` : 'Pulse';

  return (
    <div className="h-full flex flex-col px-6 py-6">
      <PageHeader
        title={headerTitle}
        actions={
          <>
            <SpecPicker
              value={specHandle}
              onChange={setSpecHandle}
              specs={pickerSpecs}
              loading={specsLoading}
            />
            <ScopeToggle value={scope} onChange={setScope} />
            <PulseLivenessDot status={status} />
          </>
        }
      />

      {/* Active-client chips row — only under 'me' scope (dec-7). */}
      {scope === 'me' && activeClients.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-4 flex-none">
          {activeClients.map((c) => (
            <ClientChip
              key={c.id}
              label={c.label}
              live={c.live}
              active={clientId === c.id}
              onClick={() => toggleClient(c.id)}
            />
          ))}
        </div>
      )}

      {/* Two columns desktop (feed ~2fr, tray ~1fr); stacked on mobile. */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 min-h-0 flex flex-col rounded-lg border border-edge-subtle bg-surface/40 overflow-hidden">
          <ActivityFeed
            rows={mergedRows}
            status={status}
            eventsLastHour={eventsLastHour}
            loading={loading}
            hasMore={hasMore}
            onLoadOlder={loadOlder}
            contextBriefHandle={selectedSpec?.handle}
            specTitle={specTitle}
          />
        </div>
        <div className="lg:col-span-1 min-h-0 overflow-y-auto">
          <NeedsAttentionTray briefId={selectedSpec?.id} />
        </div>
      </div>
    </div>
  );
}

// The header's global liveness dot — green/pulsing when connected, amber while
// connecting/reconnecting, red when the stream is dead. Mirrors the feed's
// status-line dot so the two never disagree.
function PulseLivenessDot({ status }: { status: PulseConnectionStatus }) {
  const live = status === 'connected';
  const hue =
    status === 'connected'
      ? 'text-status-success-text'
      : status === 'dead'
      ? 'text-status-danger-text'
      : 'text-status-warning-text';
  // Mirror the feed status-line copy so the header dot and the feed never
  // disagree: a 'dead' (stalled >30s) stream reads "Reconnecting", same as the
  // transient backoff 'reconnecting'.
  const label =
    status === 'connected'
      ? 'Live'
      : status === 'connecting'
      ? 'Connecting'
      : 'Reconnecting';
  return <LiveDot live={live} size="md" className={hue} title={`Connection: ${label.toLowerCase()}`} />;
}
