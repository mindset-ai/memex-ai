import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { fetchDocs } from '../api/client';
import { type DocSummary } from '../api/types';
import { useDocChangeStream } from '../hooks/useDocChangeStream';
import { formatDate } from '../utils/format';
import { Spinner } from '../components/Spinner';
import { tenantPath } from '../utils/tenantUrl';

/**
 * Generic document list (per dec-25). Renders documents whose `docType` is
 * NOT `spec` or `standard` — i.e. runbooks, ADRs, execution plans, and
 * anything else that doesn't have its own primitive-specific page.
 *
 * The server's `/api/docs?type=` query is a single-value equality filter, so
 * this page fetches all docs and filters client-side. A typical memex has a
 * small enough doc count that this is a non-issue; if it ever grows, swap to a
 * server-side `?excludeType=...` filter.
 */
export function DocumentList() {
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadDocs = useCallback(() => {
    fetchDocs()
      .then((data) => {
        const filtered = data.filter(
          (d) => d.docType !== 'spec' && d.docType !== 'standard'
        );
        const sorted = [...filtered].sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
        setDocs(sorted);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadDocs();
  }, [loadDocs]);

  useDocChangeStream(null, loadDocs);

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
          Failed to load documents: {error}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col px-6 py-6">
      <div className="flex items-center justify-between mb-6 flex-none">
        <h1 className="text-2xl font-semibold text-heading">Documents</h1>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {docs.length === 0 ? (
          <div className="border border-edge-subtle rounded-lg p-8 text-center bg-surface/40">
            <p className="text-sm text-secondary mb-1">No documents yet.</p>
            <p className="text-xs text-muted">
              Documents are general knowledge artifacts — specs, ADRs,
              runbooks, design notes, architecture overviews. They&rsquo;re
              first-class containers for human-authored content; no special
              agent maintenance, just durable references your Org relies on.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {docs.map((d) => (
              <Link
                key={d.id}
                to={tenantPath(`/docs/${d.handle}`)}
                className="block border rounded-md p-4 transition-all bg-panel border-edge-subtle hover:border-edge hover:bg-card-hover"
                data-testid="document-card"
              >
                <h3 className="text-sm font-medium text-heading leading-snug mb-2">
                  {d.title}
                </h3>
                <div className="flex items-center gap-2 text-xs text-muted flex-wrap">
                  <span className="font-mono">{d.handle}</span>
                  <span className="opacity-40">&middot;</span>
                  <span>{d.docType}</span>
                  <span className="opacity-40">&middot;</span>
                  <span>{d.status}</span>
                  <span className="opacity-40">&middot;</span>
                  <span>{formatDate(d.createdAt)}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
