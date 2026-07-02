// spec-300 t-6 — the Skills list page. One card per active skill: name,
// description, capability chips, and its handle. Empty state invites the first
// skill. Alphabetical by name (the server sorts; we re-sort defensively so the
// order is stable even if a caller reorders). A search box filters by name +
// handle + description, mirroring the Standards list affordance.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { fetchSkills, type SkillListItem } from '../api/skills';
import { Spinner } from '../components/Spinner';
import { PageHeader } from '../components/PageHeader';
import { Button } from '../components/ui';
import { tenantPath } from '../utils/tenantUrl';
import { CapabilityChips } from '../components/skills/CapabilityChips';
import { CreateSkillModal } from '../components/skills/CreateSkillModal';

function matchesQuery(query: string, skill: SkillListItem): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    skill.name.toLowerCase().includes(q) ||
    skill.handle.toLowerCase().includes(q) ||
    skill.description.toLowerCase().includes(q)
  );
}

export function SkillList() {
  const [skills, setSkills] = useState<SkillListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetchSkills()
      .then((data) => {
        const sorted = [...data].sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
        );
        setSkills(sorted);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load skills'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(
    () => skills.filter((s) => matchesQuery(query, s)),
    [skills, query],
  );

  return (
    <div className="px-6 py-6">
      <PageHeader
        title="Skills"
        actions={
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() => setCreating(true)}
            data-testid="new-skill-button"
          >
            + New skill
          </Button>
        }
      />

      {skills.length > 0 && (
        <div className="flex items-center gap-2 pb-3">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search skills…"
            aria-label="Search skills"
            className="text-xs px-3 py-1.5 w-56 rounded-sm border border-edge bg-transparent text-primary placeholder:text-muted focus:outline-hidden focus:border-edge-strong"
            data-testid="skills-search"
          />
        </div>
      )}

      <div>
        {loading ? (
          <div className="flex justify-center items-center min-h-[40vh]">
            <Spinner />
          </div>
        ) : error ? (
          <div className="bg-status-danger-bg border border-status-danger-border rounded-lg p-4 text-status-danger-text">
            Failed to load skills: {error}
          </div>
        ) : skills.length === 0 ? (
          <div
            className="border border-edge-subtle rounded-lg p-8 text-center bg-surface/40"
            data-testid="skills-empty"
          >
            <p className="text-sm text-secondary mb-1">No skills yet.</p>
            <p className="text-xs text-muted">
              A skill is a reusable SKILL.md the agent can pick up — steps, context, and
              any files it needs. Upload one or write it in the app to get started.
            </p>
            <div className="mt-4 flex justify-center">
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => setCreating(true)}
                data-testid="skills-empty-cta"
              >
                + New skill
              </Button>
            </div>
          </div>
        ) : visible.length === 0 ? (
          <div className="text-sm text-secondary py-12 text-center" data-testid="skills-search-empty">
            No skills match “{query.trim()}”.
          </div>
        ) : (
          <div
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
            data-testid="skills-grid"
          >
            {visible.map((s) => (
              <Link
                key={s.handle}
                to={tenantPath(`/skills/${s.handle}`)}
                className="block border rounded-md p-4 transition-all bg-panel border-edge-subtle hover:border-edge hover:bg-card-hover"
                data-testid="skill-card"
              >
                <h3 className="text-sm font-medium text-heading leading-snug mb-1">{s.name}</h3>
                {s.description && (
                  <p className="text-xs text-secondary line-clamp-3 mb-2">{s.description}</p>
                )}
                <CapabilityChips capabilities={s.capabilities} className="mb-2" />
                <div className="flex items-center gap-2 text-xs text-muted">
                  <span className="font-mono">{s.handle}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {creating && (
        <CreateSkillModal
          onClose={() => {
            setCreating(false);
            load();
          }}
        />
      )}
    </div>
  );
}
