import { useEffect, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { fetchDocs } from '../api/client';
import { type DocSummary } from '../api/types';
import { useDocChangeStream } from '../hooks/useDocChangeStream';
import { formatDate } from '../utils/format';
import { Spinner } from '../components/Spinner';
import { tenantPath, getCurrentTenant } from '../utils/tenantUrl';
import { PageHeader } from '../components/PageHeader';
import { StandardsMap } from '../components/StandardsMap';
import { matchesQuery } from '../components/standards-map/model';

/**
 * Standard list (per dec-25). Renders only `docType='standard'` documents.
 *
 * Drift counts are fetched as part of the same `/api/docs?type=standard&include=driftCount`
 * call (t-19 W2 aggregate endpoint), so the list stays one round-trip regardless of
 * standard count — replaces the previous N+1 fan-out via fetchDocComments.
 */
// spec-179 (ac-16): the list ⇄ map view toggle persists per user per tenant.
// localStorage is the per-user store the UI already has client-side; the key
// is tenant-scoped so different memexes can hold different modes. The list is
// the default view; the map is one click away.
type StandardsView = 'list' | 'map';

function viewStorageKey(): string {
  const t = getCurrentTenant();
  return `memex:standards-view:${t ? `${t.namespace}/${t.memex}` : 'default'}`;
}

function loadStoredView(): StandardsView {
  try {
    return localStorage.getItem(viewStorageKey()) === 'map' ? 'map' : 'list';
  } catch {
    return 'list';
  }
}

export function StandardList() {
  const navigate = useNavigate();
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<StandardsView>(loadStoredView);
  // Shared toolbar state — the search query means the same thing in both
  // views (filter the list / highlight map hits) and survives the switch.
  const [query, setQuery] = useState('');
  const [showSemantic, setShowSemantic] = useState(false);
  const [semanticAvailable, setSemanticAvailable] = useState(false);

  const switchView = useCallback((next: StandardsView) => {
    setView(next);
    try {
      localStorage.setItem(viewStorageKey(), next);
    } catch {
      // Storage can be unavailable (private mode); the toggle still works for
      // the session, it just won't persist.
    }
  }, []);

  const loadStandards = useCallback(() => {
    fetchDocs('standard', { include: ['driftCount'] })
      .then((data) => {
        const sorted = [...data].sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
        setDocs(sorted);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadStandards();
  }, [loadStandards]);

  // Keep standard counts live as the agent flags drift — same SSE channel as
  // the spec board (per-account global stream).
  useDocChangeStream(null, loadStandards);

  // Same matcher the map uses for hit-highlighting (handle + title substring).
  const visibleDocs = docs.filter((d) => matchesQuery(query, d.handle, d.title));

  if (loading) {
    return (
      <div className="flex justify-center items-center min-h-[50vh]">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-6 py-8">
        <div className="bg-status-danger-bg border border-status-danger-border rounded-lg p-4 text-status-danger-text">
          Failed to load standards: {error}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col px-6 py-6">
      <PageHeader
        title="Standards"
        actions={
          /* spec-179 (ac-3/ac-16): list ⇄ map segmented control. */
          <div
            className="flex rounded border border-edge overflow-hidden"
            role="group"
            aria-label="Standards view"
            data-testid="standards-view-toggle"
          >
            {(['list', 'map'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => switchView(mode)}
                aria-pressed={view === mode}
                className={`text-xs px-3 py-1.5 transition-colors ${
                  view === mode
                    ? 'bg-card-hover text-heading'
                    : 'text-secondary hover:bg-card-hover'
                }`}
                data-testid={`standards-view-${mode}`}
              >
                {mode}
              </button>
            ))}
          </div>
        }
      />

      {/* Shared toolbar — identical position in both views: search first
          (left), then the semantic toggle (map view only). */}
      <div className="flex items-center gap-2 pb-3">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search standards…"
          aria-label="Search standards"
          className="text-xs px-3 py-1.5 w-56 rounded border border-edge bg-transparent text-primary placeholder:text-muted focus:outline-none focus:border-edge-strong"
          data-testid="standards-search"
        />
        {view === 'map' && (
          <button
            type="button"
            onClick={() => setShowSemantic((v) => !v)}
            disabled={!semanticAvailable}
            className={`text-xs px-3 py-1.5 rounded border transition-colors ${
              showSemantic
                ? 'border-edge bg-card-hover text-heading'
                : 'border-edge text-secondary hover:bg-card-hover'
            } disabled:opacity-40 disabled:cursor-not-allowed`}
            title={
              semanticAvailable
                ? 'Overlay embedding-similarity edges (fuzzy — not citations)'
                : 'No semantic edges yet — embeddings haven’t been generated for this memex'
            }
            data-testid="semantic-toggle"
          >
            {showSemantic ? '◉' : '○'} semantic neighbors
          </button>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {view === 'map' ? (
          <StandardsMap
            query={query}
            showSemantic={showSemantic}
            onSemanticAvailable={setSemanticAvailable}
          />
        ) : docs.length === 0 ? (
          <div className="border border-edge-subtle rounded-lg p-8 text-center bg-surface/40">
            <p className="text-sm text-secondary mb-1">No standards yet.</p>
            <p className="text-xs text-muted">
              Standards are living rule documents the agent maintains —
              sections of rules, conventions, and invariants that cite the
              decisions justifying them. The agent flags drift when those
              decisions resolve, so the rules stay honest over time.
            </p>
          </div>
        ) : visibleDocs.length === 0 ? (
          <div
            className="text-sm text-secondary py-12 text-center"
            data-testid="standards-search-empty"
          >
            No standards match “{query.trim()}”.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {visibleDocs.map((d) => {
              const drift = d.driftCount ?? 0;
              return (
                <Link
                  key={d.id}
                  to={tenantPath(`/standards/${d.handle}`)}
                  className="block border rounded-md p-4 transition-all bg-panel border-edge-subtle hover:border-edge hover:bg-card-hover"
                  data-testid="standard-card"
                >
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <h3 className="text-sm font-medium text-heading leading-snug">
                      {d.title}
                    </h3>
                    {drift > 0 && (
                      <span
                        role="link"
                        tabIndex={0}
                        onClick={(e) => {
                          // The card itself is a <Link>; stop it firing and jump to
                          // the Drift Inbox filtered to this standard (b-63).
                          e.preventDefault();
                          e.stopPropagation();
                          navigate(`${tenantPath('/drift')}?doc=${d.handle}`);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            e.stopPropagation();
                            navigate(`${tenantPath('/drift')}?doc=${d.handle}`);
                          }
                        }}
                        className="flex-none cursor-pointer text-xs font-medium px-2 py-0.5 rounded-full bg-status-danger-bg text-status-danger-text border border-status-danger-border hover:opacity-90"
                        data-testid="standard-drift-count"
                        title={`${drift} open drift comment${drift === 1 ? '' : 's'} — view in the Drift Inbox`}
                      >
                        {drift} drift
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted flex-wrap">
                    <span className="font-mono">{d.handle}</span>
                    <span className="opacity-40">&middot;</span>
                    <span>{formatDate(d.createdAt)}</span>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
