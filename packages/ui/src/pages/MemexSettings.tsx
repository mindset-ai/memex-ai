// spec-111 t-7 (ac-4) — the per-Memex settings page.
//
// There was no per-memex settings surface before spec-111 (only org-level
// OrgConfiguration), so this is the first one. It mounts the visibility editor
// (<MemexVisibilitySettings/>), which reads/writes the Memex's public/private
// flag through the /api/<ns>/<mx>/memexes/:id surface (owner/admin gated
// server-side per std-7).
//
// Mounted under the tenant route `/:namespace/:memex/settings`. The memexId is
// resolved from the membership row matching the URL tenant (same pattern as
// ScaffoldInspect / AppShell) — that's the Memex the page edits.

import { useLocation } from 'react-router-dom';
import { useAuth } from '../components/AuthContext';
import { parseTenantFromPathname } from '../utils/tenantUrl';
import { MemexVisibilitySettings } from '../components/MemexVisibilitySettings';
import { PageHeader } from '../components/PageHeader';

export function MemexSettings() {
  const { session } = useAuth();
  const location = useLocation();
  const tenant = parseTenantFromPathname(location.pathname);
  const currentMembership = tenant
    ? session?.memberships.find(
        (m) => m.slug === tenant.namespace && m.memexSlug === tenant.memex,
      )
    : session?.memberships.find((m) => m.memexId === session?.currentMemexId);
  const memexId = currentMembership?.memexId ?? session?.currentMemexId ?? null;
  // Admins only. The visibility PATCH is admin-gated server-side; guard the
  // route too so a non-admin (or a visited read-only viewer, who comes back as
  // role:'member') can't reach the settings UI by typing the URL. Personal-Memex
  // owners are role:'administrator', so they keep access to their own Memex.
  const isAdmin = currentMembership?.role === 'administrator';

  if (!isAdmin) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-6 space-y-6">
        <PageHeader title="Settings" />
        <p className="text-sm text-secondary">
          Only administrators can configure this Memex.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-6 py-6 space-y-6">
      <PageHeader title="Settings" />
      {memexId ? (
        // Emission keys moved to their own member-visible page (spec-129 dec-8,
        // Option B): /<ns>/<mx>/keys. This admin-only page keeps Memex visibility.
        <MemexVisibilitySettings memexId={memexId} />
      ) : (
        <div className="text-sm text-muted">No Memex selected.</div>
      )}
    </div>
  );
}
