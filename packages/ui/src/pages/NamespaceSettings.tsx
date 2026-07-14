import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useAuth } from '../components/AuthContext';
import { listMyNamespacesApi, type NamespaceGroup } from '../api/client';
import { RenameNamespaceSection } from '../components/RenameNamespaceSection';
import { PageHeader } from '../components/PageHeader';
import { Spinner } from '../components/Spinner';

// spec-481 t-2 (ac-4/ac-1) — the per-namespace settings page, mounted at
// /:namespace/settings (safe above /:namespace/:memex because `settings` is a
// reserved slug, so no Memex can be named it). Serves both org and personal
// namespaces: it resolves the namespaceId + caller role from the caller's own
// namespace list (same source as NamespaceHome), and only an administrator sees
// the rename control (personal-namespace owners come back as `administrator`).
// Authorization is enforced server-side too (renameNamespaceSlug) per std-7;
// this gate just avoids showing a control that would 4xx.
export function NamespaceSettings() {
  const { namespace: namespaceSlug } = useParams<{ namespace: string }>();
  const { token } = useAuth();
  const [group, setGroup] = useState<NamespaceGroup | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!namespaceSlug) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    listMyNamespacesApi(token)
      .then((groups) => {
        if (cancelled) return;
        setGroup(groups.find((g) => g.namespaceSlug === namespaceSlug) ?? null);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load');
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [namespaceSlug, token]);

  if (loading) {
    return (
      <div className="flex justify-center items-center min-h-[50vh]">
        <Spinner />
      </div>
    );
  }

  const isAdmin = group?.role === 'administrator' && !!group.namespaceId;

  return (
    <div className="max-w-2xl mx-auto px-6 py-6 space-y-6">
      <PageHeader title="Namespace settings" />
      {error && <p className="text-sm text-status-danger-text">{error}</p>}
      {!error && !isAdmin && (
        <p className="text-sm text-secondary">
          Only administrators can configure this namespace.
        </p>
      )}
      {isAdmin && group && (
        <RenameNamespaceSection
          namespaceId={group.namespaceId!}
          currentSlug={group.namespaceSlug}
        />
      )}
    </div>
  );
}
