import { test, expect, tenantPath, bareUrl, DEV_EMAIL, DEV_NAME } from "./helpers/index.js";
import { seedOrgTenant } from "./helpers/retained.js";
import { setUserName } from "./helpers/seed.js";
import { installAcEmission } from "./helpers/emit-ac.js";

// spec-537 t-4 — the PR-gate journey (std-28) for editing your own display name.
//
// The whole point of this Spec is that a name set at signup used to be permanent:
// /onboarding bounces you once you have a name, and the onboarding identity step is
// inert (spec-433 put it in HIDDEN_STEP_IDS). So the loop this journey drives IS the
// feature — open the account menu, reach the page from there, rename, and see the new
// name without reloading.
//
// Two things here are unreachable by any unit test, which is why they live in a browser:
//
//   * the menu row actually RESOLVES (scope ac-2 / std-34). A unit test asserts an href
//     string; only real navigation proves the route is registered and the page mounts.
//     A menu entry pointing at a 404 is exactly the failure std-34 exists to prevent.
//   * the repaint happens with NO RELOAD (scope ac-4). The save returns a fresh session
//     and updateSession recomputes the derived user; whether the sidebar identity card
//     re-renders from that is a property of the assembled app, and a mocked component
//     test would pass either way.
const SPEC = "mindset-prod/memex-building-itself/specs/spec-537";
const AC_CAN_RENAME = `${SPEC}/acs/ac-1`;
const AC_MENU_WORKS = `${SPEC}/acs/ac-2`;
const AC_SILENT = `${SPEC}/acs/ac-3`;
const AC_NO_RELOAD = `${SPEC}/acs/ac-4`;

const T1 =
  "a user reaches My profile from the account menu, renames themselves, and the new name appears with no reload";
const T2 = "the profile page states the email boundary and says nothing about past activity";

installAcEmission(test, import.meta.url, {
  [T1]: [AC_CAN_RENAME, AC_MENU_WORKS, AC_NO_RELOAD],
  [T2]: [AC_SILENT],
});

const RENAMED = "Renamed In Journey";

test(T1, async ({ page, resources }) => {
  const slug = resources.slug("j71a");
  const tenant = await seedOrgTenant({ slug });

  // This journey renames the SHARED dev user, so the restore has to survive a failed
  // assertion. A restore as the last statement would be skipped on any failure above
  // it, leaving "Renamed In Journey" for whatever runs next in this worker — and on
  // `make e2e` (shared dev DB) that is a real leak, not a hypothetical. The fixture's
  // beforeEach re-asserts the baseline too; try/finally means we don't depend on it.
  try {
    // Land inside the tenant shell, where the account menu lives.
    await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, "/specs"));

    // ── 1) Open the account menu and take the new row. Navigating by CLICK, not by
    //       page.goto, is the part that proves the menu entry resolves (ac-2). ──
    await page.getByText(DEV_NAME, { exact: true }).click();
    const profileRow = page.getByTestId("user-menu-profile");
    await expect(profileRow).toHaveText(/my profile/i);
    await profileRow.click();

    await expect(page).toHaveURL(bareUrl("/settings/profile"));
    await expect(page.getByRole("heading", { level: 1, name: /my profile/i })).toBeVisible();

    // ── 2) Rename. The field arrives pre-filled with the current name, and Save is
    //       inert until the value actually changes (ac-12's guard, seen from outside). ──
    const nameInput = page.getByTestId("profile-name-input");
    await expect(nameInput).toHaveValue(DEV_NAME);
    const save = page.getByTestId("profile-name-save");
    await expect(save).toBeDisabled();

    await nameInput.fill(RENAMED);
    await expect(save).toBeEnabled();
    await save.click();

    // No confirmation step — one click commits (dec-4 / spec-479 D-2).
    await expect(page.getByText(/name saved/i)).toBeVisible();

    // ── 3) The repaint, with no reload. The sidebar identity card is the account
    //       menu's own trigger, so the new name showing there IS the app-wide repaint
    //       (ac-4). Asserting the old name is gone matters as much as the new one
    //       appearing — a card rendering both would mean a stale duplicate. ──
    await expect(page.getByText(RENAMED, { exact: true })).toBeVisible();
    await expect(page.getByText(DEV_NAME, { exact: true })).toHaveCount(0);

    // ── 4) And it survives a reload, i.e. it was persisted rather than only held in
    //       local state — the failure a no-reload assertion alone would miss. ──
    await page.reload();
    await expect(page.getByTestId("profile-name-input")).toHaveValue(RENAMED);
  } finally {
    await setUserName(DEV_EMAIL, DEV_NAME);
  }
});

test(T2, async ({ page, resources }) => {
  const slug = resources.slug("j71b");
  const tenant = await seedOrgTenant({ slug });
  await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, "/specs"));
  await page.getByText(DEV_NAME, { exact: true }).click();
  await page.getByTestId("user-menu-profile").click();

  // std-34: the email boundary is STATED, not implied by the field's absence.
  const email = page.getByTestId("profile-email");
  await expect(email).toBeDisabled();
  await expect(email).toHaveValue(DEV_EMAIL);
  await expect(page.getByText(/can't be changed here/i)).toBeVisible();

  // dec-4: the user chose silence about historical attribution. This pins that
  // choice on the assembled page, so re-adding the helper line is a deliberate
  // reopening of dec-4. (The history guarantee itself is ac-13, server-side.)
  await expect(
    page.getByText(/previous name|old name|past activity|already recorded/i),
  ).toHaveCount(0);
});
