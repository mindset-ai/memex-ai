// spec-129 dec-8 (t-12) — the per-Memex "Memex keys" page.
//
// Option B: emission keys live on their OWN member-visible page, separate from the
// admin-only "Memex settings" (visibility) page. Any writing member of the current Memex
// can manage keys here; the server role-scopes what they see and can revoke:
//   - member        → create; list-own; revoke-own.
//   - administrator → create; list-all; revoke-any.
//
// Access here is gated on write membership (useMemexAccess → canWrite), mirroring every
// other create/edit surface. A read-only visitor (or anonymous) is shown a notice rather
// than the key tools; the server enforces the same boundary regardless.

import { useLocation } from 'react-router-dom';
import { useMemexAccess } from '../hooks/useMemexAccess';
import { PageHeader } from '../components/PageHeader';
import { EmissionKeysSection } from '../components/EmissionKeysSection';

export function MemexKeys() {
  const location = useLocation();
  const { canWrite } = useMemexAccess(location.pathname);

  if (!canWrite) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-6 space-y-6">
        <PageHeader title="Memex keys" />
        <p className="text-sm text-secondary">
          You need to be a member of this Memex to manage its emission keys.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto px-6 py-6 space-y-6">
      <PageHeader title="Memex keys" />
      <EmissionKeysSection />
    </div>
  );
}
