import { useEffect, useState } from 'react';
import { Alert } from '../components/ui/Alert';

// Read-only A/B scoreboard for Backstage (spec-426 ac-4). Lists every Experiment with a
// per-arm tally — users assigned, succeeded / failed / pending, and the success rate —
// so an operator can read "is B beating A?" at a glance. No authoring or manual
// assignment controls here; those come in a later Spec.
//
// Opt-in dev-mode tool, same posture as the Backstage Memex picker: the backend returns
// 403 when GOOGLE_CLIENT_ID is set, so hitting this page in prod shows an error state.
interface VariantTally {
  variantId: string;
  key: string;
  label: string;
  isControl: boolean;
  behaviour: string;
  assigned: number;
  succeeded: number;
  failed: number;
  pending: number;
  // success rate over DECIDED assignments (succeeded + failed); null when nothing is
  // decided yet — rendered as "—" rather than a misleading 0%.
  successRate: number | null;
}

interface BackstageExperiment {
  experimentId: string;
  key: string;
  statement: string;
  status: string;
  windowDays: number;
  createdAt: string;
  variants: VariantTally[];
}

function formatRate(rate: number | null): string {
  if (rate === null) return '—';
  return `${Math.round(rate * 100)}%`;
}

// Map a lifecycle status to a small badge style. Mirrors the flag-badge treatment on the
// Backstage Memex picker.
function statusBadgeClass(status: string): string {
  switch (status) {
    case 'running':
      return 'bg-status-success-bg text-status-success-text';
    case 'concluded':
      return 'bg-btn-secondary text-secondary';
    default:
      return 'bg-btn-secondary text-muted';
  }
}

export function BackstageExperiments() {
  const [experiments, setExperiments] = useState<BackstageExperiment[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/backstage/experiments')
      .then(async (res) => {
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
        }
        return res.json();
      })
      .then(setExperiments)
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <div className="min-h-screen bg-page p-8">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-baseline justify-between mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-heading">Experiments</h1>
            <p className="text-sm text-secondary mt-1">
              A/B scoreboard. Per arm: who's assigned, and how many succeeded, failed, or
              are still pending. Read-only.
            </p>
          </div>
          <a href="/backstage" className="text-xs text-secondary hover:text-primary underline">
            ← Backstage
          </a>
        </div>

        {error && (
          <Alert variant="danger" size="md">
            {error}
          </Alert>
        )}

        {!experiments && !error && <div className="text-sm text-muted">Loading…</div>}

        {experiments && experiments.length === 0 && (
          <div className="text-sm text-muted">No experiments yet.</div>
        )}

        {experiments && experiments.length > 0 && (
          <div className="space-y-6">
            {experiments.map((exp) => (
              <div
                key={exp.experimentId}
                className="rounded-xl border border-edge bg-card overflow-hidden"
              >
                <div className="px-4 py-3 border-b border-edge">
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="flex items-baseline gap-2 min-w-0">
                      <code className="text-xs text-secondary shrink-0">{exp.key}</code>
                      <span
                        className={`px-1.5 py-0.5 rounded-sm text-xs ${statusBadgeClass(
                          exp.status,
                        )}`}
                      >
                        {exp.status}
                      </span>
                    </div>
                    <span className="text-xs text-muted shrink-0">
                      window {exp.windowDays}d
                    </span>
                  </div>
                  <p className="text-sm text-primary mt-1">{exp.statement}</p>
                </div>

                {exp.variants.length === 0 ? (
                  <div className="px-4 py-3 text-sm text-muted">No variants.</div>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-edge text-xs text-muted text-left">
                        <th className="px-4 py-2 font-medium">Arm</th>
                        <th className="px-4 py-2 font-medium">Behaviour</th>
                        <th className="px-4 py-2 font-medium text-right">Assigned</th>
                        <th className="px-4 py-2 font-medium text-right">Succeeded</th>
                        <th className="px-4 py-2 font-medium text-right">Failed</th>
                        <th className="px-4 py-2 font-medium text-right">Pending</th>
                        <th className="px-4 py-2 font-medium text-right">Success rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {exp.variants.map((v) => (
                        <tr
                          key={v.variantId}
                          className="border-b border-edge last:border-0"
                        >
                          <td className="px-4 py-2 text-primary">
                            <span className="font-medium">{v.key}</span>
                            <span className="text-secondary"> · {v.label}</span>
                            {v.isControl && (
                              <span className="ml-1.5 px-1.5 py-0.5 rounded-sm bg-btn-secondary text-muted text-xs">
                                control
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-2">
                            <code className="text-xs text-secondary">{v.behaviour}</code>
                          </td>
                          <td className="px-4 py-2 text-right text-secondary">{v.assigned}</td>
                          <td className="px-4 py-2 text-right text-status-success-text">
                            {v.succeeded}
                          </td>
                          <td className="px-4 py-2 text-right text-secondary">{v.failed}</td>
                          <td className="px-4 py-2 text-right text-muted">{v.pending}</td>
                          <td className="px-4 py-2 text-right text-primary font-medium">
                            {formatRate(v.successRate)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
