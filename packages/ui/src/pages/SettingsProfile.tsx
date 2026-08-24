// spec-537 t-2 (dec-1) — the user's own account surface, reached from "My profile" in
// the account menu.
//
// Flat route `/settings/profile`, NOT `/profile`: tenancy is path-based on the apex
// (std-2), and `settings` is on std-3 cl-6's reserved-slug list while `profile` is not
// — so nesting here costs no reserved-list edit and cannot shadow a namespace. Same
// collision-safety argument spec-481 dec-1 used to carve `/:namespace/settings`.
//
// AppShell's <main> is `overflow-hidden`, so the page owns its own scroll container
// (the pattern SettingsIntegrations and Standard both use).
//
// Open core — no `.ee.` marker (std-25): editing your own display name is table-stakes
// account management, not an Enterprise capability.
import { ProfileNameSection } from '../components/ProfileNameSection';

export function SettingsProfile() {
  return (
    <div className="h-full overflow-y-auto" data-testid="profile-scroll">
      <div className="max-w-3xl mx-auto px-8 py-8 space-y-14">
        <div>
          <h1 className="text-xl font-semibold mb-2 text-heading">My profile</h1>
          {/* scope ac-5: say which identity this page governs, and point elsewhere for
              the two it doesn't — a user should never wonder whether renaming here
              renames their workspace. */}
          <p className="text-sm text-secondary">
            Your name and the email you sign in with. Memex and org settings live on
            their own pages.
          </p>
        </div>

        <ProfileNameSection />
      </div>
    </div>
  );
}
