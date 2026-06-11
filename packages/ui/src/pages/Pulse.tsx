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
import { WorkingNow } from '../components/pulse/WorkingNow';
import { VitalsStrip } from '../components/pulse/VitalsStrip';
import { HotSpecs } from '../components/pulse/HotSpecs';
import { NeedsAttentionTray } from '../components/pulse/NeedsAttentionTray';
import { SpecPicker, type SpecPickerSpec } from '../components/pulse/SpecPicker';
import { ScopeToggle, type PulseScope } from '../components/pulse/ScopeToggle';
import { ClientChip } from '../components/pulse/ClientChip';
import { clientLabel } from '../components/pulse/clientLabel';
import { usePulseHistory } from '../hooks/usePulseHistory';
import { usePulseStream } from '../hooks/usePulseStream';
import { usePresence } from '../hooks/usePresence';
import { useTestSignalPulse } from '../hooks/useTestSignalPulse';
import { TestSignalsMonitor } from '../components/pulse/TestSignalsMonitor';
import { TestSignalCounter } from '../components/pulse/TestSignalCounter';
import { mergeTestSignals, type LiveTestSignal } from '../components/pulse/testSignals';
import { isMeaningfulWork } from '../components/pulse/pulseDerive';
import type { ActivityRow, PulseConnectionStatus } from '../components/pulse/types';

// spec-122 ac-2 — detect a REGRESSION on a moving line: a previously-verified AC
// going red. There's no dedicated server-side "regressed" action, so we read the
// signal off the AC/verification activity narrative (red / regress / fail). Kept
// deliberately narrow — only AC/document/standard_drift entities qualify, so a
// task or comment mentioning "failed" never trips the alarm.
const REGRESSION_NARRATIVE = /\b(regress|went red|now red|failing|failed|red)\b/i;
function isRegressionRow(row: ActivityRow): boolean {
  if (row.action !== 'updated' && row.action !== 'created') return false;
  const e = row.entity;
  if (e !== 'document' && e !== 'standard_drift') return false;
  return REGRESSION_NARRATIVE.test(row.narrative);
}

// A client is shown as an active chip if it produced an event in this window…
const ACTIVE_CLIENT_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
// …and its dot "breathes" (live) if it produced one this recently.
const CLIENT_LIVE_WINDOW_MS = 30 * 1000; // 30 seconds
// Cap on the in-memory live-row buffer so a long-lived session doesn't grow
// unbounded. The feed only ever needs the most recent live rows; older ones
// have long since been superseded by paged-in history.
const LIVE_BUFFER_CAP = 200;
// Live test-signal buffer cap — the firehose can be busy; we only need enough to
// bridge the ~45s between baseline refetches. Older ones have been folded in.
const TEST_SIGNAL_BUFFER_CAP = 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

function rowMs(row: ActivityRow): number {
  return new Date(row.createdAt).getTime();
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

  // ── Scope: default 'everyone'. The board is a shared situational picture —
  // you want the whole Memex's activity first, then narrow to 'me' on demand
  // (dec-7's 'me' default read as too narrow for a glance-at-the-board surface).
  const [scope, setScope] = useState<PulseScope>('everyone');

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

  // ── Spec list for the picker + the Hot Specs / Vitals bands. Refetched on a
  // short poll AND on reconnect so phase + AC health stay LIVE (spec-255): a
  // one-shot fetch left the cards frozen (phase chip never popped, new ACs never
  // showed) until a full page reload. ──
  const [specDocs, setSpecDocs] = useState<DocSummary[]>([]);
  const [specsLoading, setSpecsLoading] = useState(true);
  const refreshSpecs = useCallback(() => {
    fetchDocs('spec', { include: ['acHealth'] })
      .then((docs) => setSpecDocs(docs))
      // Non-fatal: keep the last-known list rather than blanking the bands.
      .catch(() => {})
      .finally(() => setSpecsLoading(false));
  }, []);
  useEffect(() => {
    refreshSpecs();
    const id = setInterval(refreshSpecs, 15_000);
    return () => clearInterval(id);
  }, [refreshSpecs]);

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
  // Under 'me' the actor filter is the session's user id. While the session is
  // still resolving (currentUserId === null) we'd otherwise fetch UNFILTERED
  // (actorUserId undefined → server returns everyone), flash those rows in, then
  // refetch filtered once the id lands — the "appeared then disappeared" glitch.
  // Gate the fetch until the id resolves so the page shows its spinner instead.
  // 'everyone' has no such dependency, so it's always enabled.
  const historyEnabled = scope !== 'me' || currentUserId !== null;
  const history = usePulseHistory({
    actorUserId,
    briefId: specId,
    clientId: clientId ?? undefined,
    enabled: historyEnabled,
  });
  const { rows: historyRows, loading, hasMore, loadOlder, refresh } = history;

  // ── Live rows from the stream. The stream is the whole-Memex firehose, so we
  // accumulate then filter client-side to match the active scope/spec/client. ─
  const [liveRows, setLiveRows] = useState<ActivityRow[]>([]);
  // Resolve the selected spec's id inside the onRow callback without making the
  // callback identity depend on it (the stream re-subscribes on identity change).
  const selectedSpecIdRef = useRef<string | null>(null);
  selectedSpecIdRef.current = selectedSpec?.id ?? null;

  // Live test-emission signals, distilled from the SSE `test_event` firehose.
  // These NEVER enter the event-log feed (they're aggregate telemetry); they
  // feed the test-signal monitor + counter only.
  const [liveTestSignals, setLiveTestSignals] = useState<LiveTestSignal[]>([]);

  const handleRow = useCallback((row: ActivityRow) => {
    // test_event is the CI firehose — route it to the signal monitor, never the
    // feed. It carries its outcome on payload.status (server emit).
    if (row.entity === 'test_event') {
      const raw = row.payload?.status;
      // Explicitly typed (not relying on flow-narrowing surviving into the
      // setState closure — the production tsc widens it back to string).
      const status: LiveTestSignal['status'] | null =
        raw === 'pass' || raw === 'fail' || raw === 'error' ? raw : null;
      if (status) {
        setLiveTestSignals((prev) => {
          const next: LiveTestSignal[] = [...prev, { at: row.createdAt, status }];
          return next.length > TEST_SIGNAL_BUFFER_CAP ? next.slice(-TEST_SIGNAL_BUFFER_CAP) : next;
        });
      }
      return;
    }
    setLiveRows((prev) => {
      const next = [row, ...prev];
      return next.length > LIVE_BUFFER_CAP ? next.slice(0, LIVE_BUFFER_CAP) : next;
    });
  }, []);

  // ── Test-signal monitor (right column) + counter (working-now). Baseline from
  // the analytics endpoint; live SSE frames top it up between refetches. ────────
  const {
    pulse: testSignalPulse,
    loading: testSignalsLoading,
    fetchedAt: testSignalsFetchedAt,
    refresh: refreshTestSignals,
  } = useTestSignalPulse(60);
  // Every successful baseline refetch already includes the signals we buffered
  // live, so drop the buffer to avoid double-counting them (the "+N new" resets).
  useEffect(() => {
    setLiveTestSignals([]);
  }, [testSignalsFetchedAt]);
  const mergedTestSignals = useMemo(
    () => mergeTestSignals(testSignalPulse, liveTestSignals),
    [testSignalPulse, liveTestSignals],
  );

  // On SSE reconnect, refetch BOTH the activity history and the test-signal
  // baseline so any gap during the outage converges.
  const handleReconnect = useCallback(() => {
    void refresh();
    void refreshTestSignals();
    refreshSpecs();
  }, [refresh, refreshTestSignals, refreshSpecs]);

  const { status } = usePulseStream({ onRow: handleRow, onReconnect: handleReconnect });

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

  // ── Working-now zone (ac-1): presence across every spec. The presence GET
  // endpoint is per-spec, so we poll it for each spec handle and the hook merges
  // the results into one "who's here now" set. We pass bare `spec-N` handles —
  // the endpoint accepts either a full ref or a bare handle. ───────────────────
  const specRefs = useMemo(
    () => specDocs.map((d) => d.handle),
    [specDocs],
  );
  const { rows: presentRows, loading: presenceLoading } = usePresence(specRefs);

  // docId → spec handle / title, for the Working-now lines (presence rows carry
  // the spec's doc id; the spec list carries handle + title keyed by id).
  const specHandleByDocId = useCallback(
    (docId: string): string | undefined => specDocs.find((d) => d.id === docId)?.handle,
    [specDocs],
  );
  const specTitleByDocId = useCallback(
    (docId: string): string | undefined => specDocs.find((d) => d.id === docId)?.title,
    [specDocs],
  );

  // The set of spec doc ids with an ACTIVE WORKER present — drives both the feed
  // tray scope and ac-2's presence-aware regression muting.
  const activeWorkerDocIds = useMemo(
    () => new Set(presentRows.map((r) => r.docId)),
    [presentRows],
  );
  const specHasActiveWorker = useCallback(
    (briefId: string | null) => !!briefId && activeWorkerDocIds.has(briefId),
    [activeWorkerDocIds],
  );

  // ── "What's moving" zone (ac-1): state-changing rows ONLY. The read actions
  // (viewed/searched/assessed/called) are the ambient firehose — a manager
  // glancing at the board shouldn't wade through them. ─────────────────────────
  // test_event is routed to the signal monitor, never the feed — but historical
  // test_event rows persisted BEFORE the sink stopped writing them still live in
  // activity_log, so filter them out here too until they age off the window.
  const movingRows = useMemo(
    () => mergedRows.filter((r) => isMeaningfulWork(r)),
    [mergedRows],
  );

  // docId → ISO of that spec's most recent moving activity, for the Working-now
  // "last moved <ago>" clock (ac-1: how long since each active spec last had
  // activity).
  const lastActivityByDocId = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of movingRows) {
      if (!r.briefId) continue;
      const prev = map.get(r.briefId);
      if (!prev || rowMs(r) > new Date(prev).getTime()) map.set(r.briefId, r.createdAt);
    }
    return map;
  }, [movingRows]);
  const lastActivityAt = useCallback(
    (docId: string): string | undefined => lastActivityByDocId.get(docId),
    [lastActivityByDocId],
  );

  // ── spec-255 resolvers for the Vitals + Hot Specs bands. ──────────────────
  const specPhaseByDocId = useCallback(
    (docId: string): string | undefined => specDocs.find((d) => d.id === docId)?.status,
    [specDocs],
  );
  const specAcHealthByDocId = useCallback(
    (docId: string) => specDocs.find((d) => d.id === docId)?.acHealth,
    [specDocs],
  );
  // docId → the present-tense narrative of that spec's most recent moving event,
  // for the Hot Specs card + Working Now line.
  const lastNarrativeByDocId = useMemo(() => {
    const map = new Map<string, { at: number; text: string }>();
    for (const r of movingRows) {
      if (!r.briefId) continue;
      const t = rowMs(r);
      const prev = map.get(r.briefId);
      if (!prev || t > prev.at) map.set(r.briefId, { at: t, text: r.narrative });
    }
    return map;
  }, [movingRows]);
  const specNarrativeByDocId = useCallback(
    (docId: string): string | undefined => lastNarrativeByDocId.get(docId)?.text,
    [lastNarrativeByDocId],
  );
  const specHref = useCallback(
    (handle: string) => `/${namespace}/${memex}/specs/${handle}`,
    [namespace, memex],
  );

  // ── eventsLastHour for the feed status line, from the moving set. ───────────
  const eventsLastHour = useMemo(() => {
    const cutoff = Date.now() - ONE_HOUR_MS;
    return movingRows.filter((r) => rowMs(r) >= cutoff).length;
  }, [movingRows]);

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

  // When a spec is selected, narrow Working-now to it too (board scope is
  // consistent across both zones); otherwise it's the whole-Memex picture.
  const displayedPresent = useMemo(() => {
    const wantSpecId = selectedSpec?.id ?? null;
    if (!wantSpecId) return presentRows;
    return presentRows.filter((r) => r.docId === wantSpecId);
  }, [presentRows, selectedSpec]);

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

      {/* spec-122 ac-1: the two-zone board. WORKING NOW (presence) sits ABOVE
          WHAT'S MOVING (the state-changing activity stream), spanning the feed
          column; the Needs-attention tray keeps its place on the right. */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 min-h-0 flex flex-col">
          {/* spec-255 — Vitals strip (graphics) then the Hot Specs hero band.
              Fed from the MERGED live+history stream (movingRows) so live events
              move the sparklines and keep a spec hot the instant they land —
              not only after a periodic history refetch. */}
          <VitalsStrip present={presentRows} activity={movingRows} />
          <HotSpecs
            present={presentRows}
            activity={movingRows}
            specHandle={specHandleByDocId}
            specTitle={specTitleByDocId}
            specPhase={specPhaseByDocId}
            specNarrative={specNarrativeByDocId}
            specAcHealth={specAcHealthByDocId}
            specHref={specHref}
          />
          {/* Live test-signal heartbeat. */}
          <TestSignalCounter
            total={mergedTestSignals.totals.total}
            windowMinutes={mergedTestSignals.windowMinutes}
            failing={mergedTestSignals.failing}
            liveDelta={liveTestSignals.length}
          />
          {/* Working Now — by person, ABOVE the Live log. */}
          <WorkingNow
            present={displayedPresent}
            loading={presenceLoading}
            specHandle={specHandleByDocId}
            specTitle={specTitleByDocId}
            lastActivityAt={lastActivityAt}
            lastNarrative={specNarrativeByDocId}
          />
          {/* Live event log — the BOTTOM band, allowed to grow tall (off-screen
              is fine): it fills the remaining height and scrolls internally. */}
          <div
            data-testid="live-band"
            className="flex-1 min-h-0 flex flex-col rounded-lg border border-edge-subtle bg-surface/40 overflow-hidden"
          >
            <ActivityFeed
              rows={movingRows}
              status={status}
              eventsLastHour={eventsLastHour}
              loading={loading}
              hasMore={hasMore}
              onLoadOlder={loadOlder}
              contextBriefHandle={selectedSpec?.handle}
              specTitle={specTitle}
              isRegression={isRegressionRow}
              specHasActiveWorker={specHasActiveWorker}
            />
          </div>
        </div>
        <div className="lg:col-span-1 min-h-0 overflow-y-auto">
          {/* Test-signal volume graphic — the firehose as a live sparkline,
              sitting ABOVE the needs-attention tray so the column reads
              "real-time pulse → things to look at". */}
          <TestSignalsMonitor
            signals={mergedTestSignals}
            loading={testSignalsLoading}
            live={liveTestSignals.length > 0}
          />
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
