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

// spec-512 dec-3 — refuse to run against another working copy's server.
//
// playwright.config.ts sets `reuseExistingServer: !CI`. When a second worktree
// finds the ports already answering, Playwright adopts THAT worktree's server:
// the journeys then exercise another branch's code against another branch's
// database and report a PASS. Proven empirically during spec-512 build — a stub
// server on the e2e port took 12 real requests while Playwright never started
// this checkout's server at all.
//
// This runs after webServer boot but before any journey, so a mismatch stops the
// suite instead of producing a green lie. It is a backstop for direct
// `playwright test` invocations; `make e2e-cold` catches it earlier and cheaper
// via scripts/ci/e2e-preflight.mjs.
async function assertServerBelongsToThisWorkspace(): Promise<void> {
  const expected = process.env.MEMEX_WORKSPACE_ID?.trim();
  if (!expected) return; // not launched by the workspace-aware tooling — nothing to compare

  const apiUrl = process.env.E2E_API_URL ?? `http://localhost:${process.env.E2E_SERVER_PORT ?? 8090}`;
  const res = await fetch(`${apiUrl}/api/health`);
  const seen = ((await res.json()) as { workspace?: string }).workspace ?? null;

  if (seen === expected) return;

  throw new Error(
    `E2E IS TALKING TO ANOTHER WORKSPACE'S SERVER (spec-512 dec-3)\n` +
      `\n` +
      `  ${apiUrl} reports workspace ${seen ?? "(none — it was not started by this tooling)"}.\n` +
      `  This run belongs to workspace ${expected}.\n` +
      `\n` +
      `  Playwright reused an already-running server instead of starting this\n` +
      `  checkout's. Every journey would have exercised the OTHER workspace's code\n` +
      `  and database and reported a pass — nothing you changed would be tested.\n` +
      `\n` +
      `  Fix — free the port, then re-run:\n` +
      `    lsof -ti tcp:${process.env.E2E_SERVER_PORT ?? 8090} | xargs -r kill\n` +
      `\n` +
      `  Check: packages/ui/e2e/global-setup.ts`,
  );
}

export default async function globalSetup(): Promise<void> {
  await assertServerBelongsToThisWorkspace();
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
