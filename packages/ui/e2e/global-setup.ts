// Playwright globalSetup (spec-172 dec-3). Runs ONCE per suite, after the
// `webServer` block has booted the server + UI (Playwright starts webServers
// before globalSetup), so the server's test-only HTTP surface is already up.
//
// On a cold, freshly-migrated CI database the server's dev-user bypass creates
// dev@memex.ai WITHOUT a display name → PostLoginRouter routes every journey
// into Onboarding. This setup ensures the dev user exists and is NAMED before
// any journey runs, matching the cold-DB posture the CI job exercises. It does
// NOT mask a product bug: a nameless user landing in Onboarding is intended, and
// the onboarding journey deliberately clears the name to walk that screen (the
// per-test fixture re-asserts the name so it can't leak forward).

import {
  ensureUser,
  setUserName,
  setIdentityConfirmed,
  DEV_EMAIL,
  DEV_NAME,
} from "./helpers/index.js";

export default async function globalSetup(): Promise<void> {
  // ensureUser provisions dev@memex.ai + its personal namespace/memex through the
  // server's real services; setUserName then gives it a display name.
  await ensureUser(DEV_EMAIL);
  await setUserName(DEV_EMAIL, DEV_NAME);
  // spec-305: needsOnboarding now keys off identity_confirmed_at (not !name), so stamp
  // the dev user identity-confirmed too — otherwise every journey is redirected to /onboarding.
  await setIdentityConfirmed(DEV_EMAIL, true);
  // spec-507 + spec-508: the welcome-video and voice-greeting pre-stamps that used to
  // close this function are gone along with the first-run gates they defended against.
}
