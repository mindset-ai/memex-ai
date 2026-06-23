// spec-171 t-25 / ac-39 / dec-40 (option A): let the caller CHOOSE which org to
// upgrade/bill. Billing is per-org (std-1 cl-3) and a user may administer several
// orgs, so the upgrade flow must surface the orgs the caller administers and bill
// the chosen one — never the session's current (personal) Memex.
//
// Behaviour:
//   • none     → a clear "create an org first" CTA (no billable target exists).
//   • exactly 1 → auto-selected; rendered read-only so the user sees WHICH org
//                  is being upgraded.
//   • many     → a chooser (radio list).
//
// Pure presentational + selection logic; the parent owns the selected org and
// passes it to the billing client calls.

import type { AdminOrg } from '../../pages/upgrade/adminOrgs';

interface OrgSelectorProps {
  orgs: AdminOrg[];
  selectedOrgId: string | null;
  onSelect: (orgId: string) => void;
  /** Navigate to where the user can create an org (their personal namespace). */
  onCreateOrg: () => void;
}

export function OrgSelector({
  orgs,
  selectedOrgId,
  onSelect,
  onCreateOrg,
}: OrgSelectorProps) {
  if (orgs.length === 0) {
    return (
      <div className="rounded-lg border border-edge bg-surface/50 px-4 py-4 space-y-2">
        <p className="text-sm font-medium text-primary">
          You don't administer any organisations yet.
        </p>
        <p className="text-sm text-muted">
          Billing is per organisation — create an organisation first, then upgrade it.
        </p>
        <button
          type="button"
          className="text-sm text-link underline hover:no-underline"
          onClick={onCreateOrg}
        >
          Create an organisation →
        </button>
      </div>
    );
  }

  if (orgs.length === 1) {
    const org = orgs[0];
    return (
      <div className="rounded-lg border border-edge bg-surface/50 px-4 py-3">
        <p className="text-xs text-muted mb-0.5">Upgrading organisation</p>
        <p className="text-sm font-medium text-primary">{org.name}</p>
      </div>
    );
  }

  return (
    <fieldset>
      <legend className="block text-sm font-medium text-primary mb-1.5">
        Which organisation are you upgrading?
      </legend>
      <div className="space-y-2">
        {orgs.map((org) => (
          <label
            key={org.orgId}
            className="flex items-center gap-3 cursor-pointer rounded-lg border border-edge bg-surface/30 px-3 py-2"
          >
            <input
              type="radio"
              name="upgrade-org"
              checked={selectedOrgId === org.orgId}
              onChange={() => onSelect(org.orgId)}
              className="accent-accent"
            />
            <span className="text-sm text-primary">{org.name}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
