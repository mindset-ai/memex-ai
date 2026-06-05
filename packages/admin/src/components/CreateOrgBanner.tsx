import { useEffect, useState } from 'react';
import { useAuth } from './AuthContext';
import { CreateOrgDialog } from './CreateOrgDialog';

const DISMISS_KEY = 'createOrgBanner:dismissed:v1';

// Per dec-8 of doc-19, render a dismissable banner on the personal Memex's
// Specs page that nudges the user toward creating an Org. Hidden once the
// user has any active org membership, or when the user explicitly dismisses
// (localStorage-persisted).
//
// Visibility is controlled by the caller — render this component only inside
// the personal Memex's Specs page. The component handles the "user has
// joined an org" + "dismissed" suppression itself.
export function CreateOrgBanner() {
  const { session } = useAuth();
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });
  const [openCreate, setOpenCreate] = useState(false);

  // Re-read on mount in case another tab toggled it.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      setDismissed(window.localStorage.getItem(DISMISS_KEY) === '1');
    } catch {
      // Storage access can throw in sandboxed contexts; default to undismissed.
    }
  }, []);

  const hasTeamMembership = session?.memberships.some((m) => m.kind === 'team') ?? false;
  if (hasTeamMembership) return null;
  if (dismissed) return null;

  function dismiss() {
    try {
      window.localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      // Ignore — banner will reappear next session if persistence fails.
    }
    setDismissed(true);
  }

  return (
    <>
      <div className="mb-6 flex items-center justify-between gap-3 px-4 py-3 rounded-lg border border-edge bg-card-hover">
        <div className="text-sm text-secondary">
          <span className="font-medium text-primary">Working with a team?</span>{' '}
          <button
            type="button"
            className="text-link underline hover:no-underline"
            onClick={() => setOpenCreate(true)}
          >
            Create an Org →
          </button>
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          className="text-muted hover:text-primary transition-colors"
          onClick={dismiss}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      {openCreate && <CreateOrgDialog onClose={() => setOpenCreate(false)} />}
    </>
  );
}
