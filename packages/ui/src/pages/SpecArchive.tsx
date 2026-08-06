// spec-521 t-4 (ac-5) — the archive view.
//
// `services/documents.ts` has carried the note "e.g. a future archive view" since
// doc-12, and the board has hidden archived Specs unconditionally with nowhere else
// to look. This builds the somewhere else.
//
// A LIST reached FROM the Specs board, not a column on it (dec/design §3.1): archived
// work should be out of the way. It is not lost, and — since spec-521 — it is not a
// one-way trip either.
//
// REASON IS THE LOAD-BEARING COLUMN. "absorbed into spec-510" and "premise gone —
// voice loop removed" are the difference between an archive and a black hole. That is
// why archiving now asks for it (ArchiveSpecDialog) and why it gets its own column
// here rather than a tooltip.
//
// ac-16 / std-34: Restore is a HUMAN action and the copy says so without naming any
// MCP tool — because no agent can archive or restore, in either direction (dec-6). An
// agent that believes a Spec is dead files an Issue against it while it is still live.

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchArchivedDocs, restoreDoc } from '../api/client';
import { type DocSummary } from '../api/types';
import { useDocChangeStream } from '../hooks/useDocChangeStream';
import { formatDate } from '../utils/format';
import { Spinner } from '../components/Spinner';
import { Button } from '../components/ui';
import { tenantPath } from '../utils/tenantUrl';

export function SpecArchive() {
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchArchivedDocs()
      .then((data) => {
        const sorted = [...data].sort(
          (a, b) =>
            new Date(b.archivedAt ?? 0).getTime() - new Date(a.archivedAt ?? 0).getTime(),
        );
        setDocs(sorted);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);
  // std-8/std-39 cl-26: archive and restore emit `document.updated` on the unified
  // bus, so this list refreshes off the existing SSE stream rather than polling.
  // First arg is the doc to subscribe to; this page watches the Memex-wide stream
  // rather than one document, so it passes null.
  useDocChangeStream(null, load);

  const handleRestore = useCallback(
    async (doc: DocSummary) => {
      setRestoringId(doc.id);
      setError(null);
      try {
        await restoreDoc(doc.id);
        // Optimistic removal — the SSE refetch confirms, and other clients converge.
        setDocs((prev) => prev.filter((d) => d.id !== doc.id));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setRestoringId(null);
      }
    },
    [],
  );

  if (loading) return <Spinner />;

  return (
    <div className="p-6 space-y-4">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-heading">Archived specs</h1>
        <p className="text-sm text-muted">
          Archived work is out of the way, not lost. While a Spec is archived Claude
          will not read it at all — not its decisions, not its acceptance criteria.
          Restore it to bring it back to the phase and content it had.
        </p>
      </div>

      {error && (
        <div role="alert" className="text-sm text-status-danger-text">
          {error}
        </div>
      )}

      {docs.length === 0 ? (
        <p className="text-sm text-muted">
          Nothing archived. When you archive a Spec it will appear here with the reason
          you gave.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">
              Archived specs, with when each was archived, by whom, and why
            </caption>
            <thead>
              <tr className="text-left text-xs uppercase tracking-wider text-muted border-b border-edge">
                <th scope="col" className="py-2 pr-4 font-medium">Spec</th>
                <th scope="col" className="py-2 pr-4 font-medium">Phase at archive</th>
                <th scope="col" className="py-2 pr-4 font-medium">Archived</th>
                <th scope="col" className="py-2 pr-4 font-medium">By</th>
                <th scope="col" className="py-2 pr-4 font-medium">Reason</th>
                <th scope="col" className="py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {docs.map((doc) => (
                <tr key={doc.id} className="border-b border-edge/50 align-top">
                  <td className="py-3 pr-4">
                    <Link
                      to={tenantPath(`/specs/${doc.handle}`)}
                      className="text-primary hover:underline"
                    >
                      <span className="text-muted mr-1.5">{doc.handle}</span>
                      {doc.title}
                    </Link>
                  </td>
                  {/* Phase-at-archive is simply the Spec's status: archiving is
                      orthogonal to phase, which is also why restore needs no phase
                      to reinstate. */}
                  <td className="py-3 pr-4 text-muted">{doc.status}</td>
                  <td className="py-3 pr-4 text-muted">
                    {doc.archivedAt ? formatDate(doc.archivedAt) : '—'}
                  </td>
                  {/* std-32: the denormalised name stamped at write, so a later
                      rename cannot rewrite who archived this. */}
                  <td className="py-3 pr-4 text-muted">{doc.archivedByName || 'Unknown'}</td>
                  <td className="py-3 pr-4 text-primary">
                    {doc.archiveReason || <span className="text-muted italic">Not recorded</span>}
                  </td>
                  <td className="py-3">
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => handleRestore(doc)}
                      disabled={restoringId === doc.id}
                      aria-label={`Restore ${doc.handle} ${doc.title}`}
                    >
                      {restoringId === doc.id ? 'Restoring…' : 'Restore'}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
