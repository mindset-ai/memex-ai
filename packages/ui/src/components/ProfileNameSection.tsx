import { useCallback, useState } from 'react';
import { Button } from './ui/Button';
import { Input } from './ui/Input';
import { Alert } from './ui/Alert';
import { useAuth } from './AuthContext';
import { updateProfileApi } from '../api/client';

// spec-537 t-3 — the user's own display name, editable after signup.
//
// Until this Spec the only writers of `users.name` were the two onboarding surfaces,
// and both are one-way doors: `/onboarding` self-redirects once a name exists
// (Onboarding.tsx L35) and IdentityStep is inert ('identity' is in HIDDEN_STEP_IDS
// since spec-433). A name set at signup was therefore permanent. spec-433's "Name
// handling" section promised Settings as "a pre-existing surface"; it wasn't one.
// This is that surface (spec-537 issue-1 tracks correcting that record).
//
// Per dec-3 the server is untouched: PATCH /api/auth/profile and updateUserProfile()
// are reused exactly as they are. Per dec-4 this section says NOTHING about historical
// attribution — see the note on the save handler.
export function ProfileNameSection() {
  const { token, user, updateSession } = useAuth();
  const [name, setName] = useState(user?.name ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const persisted = user?.name ?? '';
  // Blank is what keeps the server's empty-name rejection unreachable from here
  // (`requireString(..., { trim: true })` would 400); unchanged avoids a no-op write.
  const canSave = !saving && trimmed !== '' && trimmed !== persisted;

  const onSave = useCallback(async () => {
    if (saving || trimmed === '' || trimmed === persisted) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      // dec-3, accepted debt: this endpoint hardcodes `confirmIdentity: true`, so every
      // save here re-stamps `users.identity_confirmed_at` — a column whose name means
      // "completed the onboarding identity step", not "last edited their name". It is
      // inert TODAY because the only readers treat it as a boolean
      // (`needsOnboarding = !user.identityConfirmedAt`, services/auth.ts:177 and :273,
      // and journey-state.ts:97 keys the identity milestone off role_coords instead).
      // If you are here because you want to read that column as a DATE: it will give you
      // "last renamed", not "onboarded at". Fix the endpoint (make confirmIdentity
      // opt-in) rather than inferring anything from the value.
      //
      // Two arguments only — passing roleCoords would write to the field spec-433
      // deliberately parked.
      const session = await updateProfileApi(token, trimmed);
      updateSession(session);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your name. Please try again.');
    } finally {
      setSaving(false);
    }
  }, [saving, trimmed, persisted, token, updateSession]);

  return (
    <section className="space-y-6" data-testid="profile-name">
      <div>
        <h3 className="text-sm font-semibold text-heading">Your name</h3>
        <p className="text-sm text-secondary mt-1">
          How you appear to everyone else — on Specs you author, in comments, and in
          mentions.
        </p>
      </div>

      {error && (
        <Alert variant="danger" size="md">
          {error}
        </Alert>
      )}

      <div className="space-y-2">
        <label className="block text-sm text-secondary">
          Display name
          <div className="flex gap-2 mt-1">
            <Input
              value={name}
              maxLength={100}
              onChange={(e) => {
                setName(e.target.value);
                setSaved(false);
              }}
              data-testid="profile-name-input"
            />
            {/* dec-4 / spec-479 D-2: commits on the first click. A name rename breaks
                no links, so it gets the display-name treatment (no confirm), not the
                slug treatment (confirm). */}
            <Button onClick={onSave} disabled={!canSave} data-testid="profile-name-save">
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </label>
        {saved && <div className="text-xs text-status-success-text">Name saved.</div>}
      </div>

      <div className="space-y-2">
        <label className="block text-sm text-secondary">
          Email
          <div className="mt-1">
            <Input value={user?.email ?? ''} disabled readOnly data-testid="profile-email" />
          </div>
        </label>
        {/* std-34: name the boundary rather than leaving the field out and letting a
            user conclude the feature is missing. Changing the sign-in address touches
            native auth (std-13), verification, and domain auto-join consent (std-6) —
            its own Spec. */}
        <p className="text-xs text-secondary">
          Your email is how you sign in, and can't be changed here.
        </p>
      </div>
    </section>
  );
}
