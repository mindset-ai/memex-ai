import { useEffect, useState, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { fetchDocs } from '../api/client';
import { type DocSummary } from '../api/types';
import { useDocChangeStream } from '../hooks/useDocChangeStream';
import { formatDate } from '../utils/format';
import { Spinner } from '../components/Spinner';
import { tenantPath, getCurrentTenant } from '../utils/tenantUrl';
import { PageHeader } from '../components/PageHeader';

/**
 * Build the templated "audit my codebase against the standards" prompt
 * (t-11 of doc-8). Pasted into a fresh Claude Code (or Desktop) session
 * connected to this Memex via MCP — the agent calls list_docs(docType:'standard'),
 * inspects each rule, and either flags drift via flag_drift or proposes
 * a corrected rule via propose_standard_change.
 *
 * The Memex name comes from the URL's tenant context (path-based after t-23).
 */
function currentMemexName(): string {
  const t = getCurrentTenant();
  if (t) return `${t.namespace}/${t.memex}`;
  // Fallback when not in a tenant URL (rare — StandardList lives under /:ns/:mx).
  return window.location.hostname;
}

function buildAuditPrompt(memexName: string, baseUrl: string, count: number): string {
  return [
    `You are auditing the current codebase against the Standards in the Memex "${memexName}" (${baseUrl}).`,
    '',
    `There are ${count} standard${count === 1 ? '' : 's'} to check. For each standard:`,
    '',
    "1. Call `list_docs({ docType: 'standard' })` and `get_doc(standardId)` to read every rule and its `[per dec-N]` provenance.",
    "2. Inspect the codebase to verify each rule. Use `code_search`, `list_symbols`, `list_symbols({ kind: 'endpoint' })`, etc.",
    '3. If the codebase has drifted from the rule, call `flag_drift(standardSectionId, observation)` describing what you observed and where (file path, function name).',
    '4. If the rule itself is wrong, ambiguous, or out of date, call `propose_standard_change(standardSectionId, proposedContent, rationale)` with the corrected text.',
    '5. Do NOT modify production code as part of this audit — only post drift / proposal comments. The standard owner reviews them in the Drift Inbox.',
    '',
    'When you finish, summarise what you flagged and what you proposed.',
  ].join('\n');
}

/**
 * Standard list (per dec-25). Renders only `docType='standard'` documents.
 *
 * Drift counts are fetched as part of the same `/api/docs?type=standard&include=driftCount`
 * call (t-19 W2 aggregate endpoint), so the list stays one round-trip regardless of
 * standard count — replaces the previous N+1 fan-out via fetchDocComments.
 */
export function StandardList() {
  const navigate = useNavigate();
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleCopyAuditPrompt() {
    const memexName = currentMemexName();
    const t = getCurrentTenant();
    const baseUrl = t
      ? `${window.location.origin}/${t.namespace}/${t.memex}`
      : window.location.origin;
    const prompt = buildAuditPrompt(memexName, baseUrl, docs.length);
    try {
      await navigator.clipboard.writeText(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard API can be blocked (insecure origin, permissions). Fall back
      // to a textarea-and-execCommand dance only if the user actually hits this.
      setError('Could not access the clipboard. Copy the prompt manually from the page source.');
    }
  }

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
          <button
            type="button"
            onClick={handleCopyAuditPrompt}
            disabled={docs.length === 0}
            className="text-xs px-3 py-1.5 rounded border border-edge text-secondary hover:bg-card-hover disabled:opacity-40 disabled:cursor-not-allowed"
            title="Copy a prompt instructing a fresh agent to audit the codebase against these standards"
            data-testid="copy-audit-prompt"
          >
            {copied ? 'Copied!' : 'Copy audit prompt'}
          </button>
        }
      />

      <div className="flex-1 min-h-0 overflow-y-auto">
        {docs.length === 0 ? (
          <div className="border border-edge-subtle rounded-lg p-8 text-center bg-surface/40">
            <p className="text-sm text-secondary mb-1">No standards yet.</p>
            <p className="text-xs text-muted">
              Standards are living rule documents the agent maintains —
              sections of rules, conventions, and invariants that cite the
              decisions justifying them. The agent flags drift when those
              decisions resolve, so the rules stay honest over time.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {docs.map((d) => {
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
