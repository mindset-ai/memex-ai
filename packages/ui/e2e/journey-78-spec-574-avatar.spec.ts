import { test, expect, tenantPath, bareUrl, DEV_EMAIL, DEV_NAME } from "./helpers/index.js";
import { seedOrgTenant } from "./helpers/retained.js";
import { setUserAvatar } from "./helpers/seed.js";
import { installAcEmission } from "./helpers/emit-ac.js";

// spec-574 t-4 — the PR-gate journey (std-28) for choosing how your avatar looks.
//
// What only a browser can prove:
//   * the account-menu avatar (the app shell's own identity card) repaints from the saved
//     session with NO RELOAD, i.e. the one Avatar really is wired to the session;
//   * the choice PERSISTS: after a reload the page reads it back from the server;
//   * going back to the automatic look restores the derived letters and neutral colour.
const SPEC = "mindset-prod/memex-building-itself/specs/spec-574";
const AC_SET = `${SPEC}/acs/ac-1`;
const AC_CLEAR = `${SPEC}/acs/ac-2`;
const AC_COLOR = `${SPEC}/acs/ac-13`;

const T1 =
  "a user chooses avatar letters and a colour, sees them in the account menu without a reload, and they persist";
const T2 = "a user goes back to the automatic avatar";

installAcEmission(test, import.meta.url, {
  [T1]: [AC_SET, AC_COLOR],
  [T2]: [AC_CLEAR, AC_COLOR],
});

// The dev user's name is "Dev User", so the automatic avatar reads "DU".
const AUTOMATIC = "DU";

// The account-menu trigger in the sidebar: the button carrying the user's name.
function accountMenuAvatar(page: import("@playwright/test").Page) {
  return page.locator("button", { hasText: DEV_NAME }).getByTestId("avatar").first();
}

// Zero console errors: the avatar touches every page (the account menu) and adds a roster
// request on team Memexes, so a broken payload or a refused request would surface here
// first. Every console error and uncaught page error during a test fails it.
function collectBrowserErrors(page: import("@playwright/test").Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  // Chrome's "Failed to load resource" console line omits the URL; record it here so a
  // failure names the request that caused it.
  page.on("response", (res) => {
    if (res.status() >= 400) errors.push(`response ${res.status()}: ${res.request().method()} ${res.url()}`);
  });
  return errors;
}

async function openProfile(page: import("@playwright/test").Page, slug: string) {
  const tenant = await seedOrgTenant({ slug });
  await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, "/specs"));
  await page.getByText(DEV_NAME, { exact: true }).click();
  await page.getByTestId("user-menu-profile").click();
  await expect(page).toHaveURL(bareUrl("/settings/profile"));
}

test(T1, async ({ page, resources }) => {
  const browserErrors = collectBrowserErrors(page);
  // The fixture resets the dev user's avatar before every test; the finally below also
  // restores it, so a failed assertion cannot leak a chosen avatar into the next journey.
  try {
    await openProfile(page, resources.slug("j78a"));

    // Precondition: nothing chosen yet, so the account menu shows the automatic look.
    await expect(accountMenuAvatar(page)).toHaveText(AUTOMATIC);
    await expect(accountMenuAvatar(page)).toHaveAttribute("data-avatar-color", "default");

    const save = page.getByTestId("profile-avatar-save");
    await expect(save).toBeDisabled();

    await page.getByTestId("profile-avatar-letters").fill("wv");
    await page.getByRole("radio", { name: "Teal" }).click();

    // The preview is the real Avatar, showing the choice before it is saved.
    const preview = page.getByTestId("profile-avatar-preview").getByTestId("avatar");
    await expect(preview).toHaveText("WV");
    await expect(preview).toHaveAttribute("data-avatar-color", "teal");

    await save.click();
    await expect(page.getByText(/avatar saved/i)).toBeVisible();

    // No reload: the account menu repaints from the returned session.
    await expect(accountMenuAvatar(page)).toHaveText("WV");
    await expect(accountMenuAvatar(page)).toHaveAttribute("data-avatar-color", "teal");

    // Persisted, not just held in page state.
    await page.reload();
    await expect(page.getByTestId("profile-avatar-letters")).toHaveValue("WV");
    await expect(page.getByRole("radio", { name: "Teal" })).toHaveAttribute("aria-checked", "true");
    await expect(accountMenuAvatar(page)).toHaveText("WV");
    expect(browserErrors).toEqual([]);
  } finally {
    await setUserAvatar(DEV_EMAIL, { avatarLabel: null, avatarColor: null });
  }
});

test(T2, async ({ page, resources }) => {
  const browserErrors = collectBrowserErrors(page);
  try {
    await setUserAvatar(DEV_EMAIL, { avatarLabel: "WV", avatarColor: "red" });
    await openProfile(page, resources.slug("j78b"));
    // Precondition: the seeded choice is what the app shows.
    await expect(accountMenuAvatar(page)).toHaveText("WV");
    await expect(accountMenuAvatar(page)).toHaveAttribute("data-avatar-color", "red");

    await page.getByRole("button", { name: /use automatic initials/i }).click();
    await page.getByRole("radio", { name: "Default" }).click();
    await page.getByTestId("profile-avatar-save").click();
    await expect(page.getByText(/avatar saved/i)).toBeVisible();

    await expect(accountMenuAvatar(page)).toHaveText(AUTOMATIC);
    await expect(accountMenuAvatar(page)).toHaveAttribute("data-avatar-color", "default");

    await page.reload();
    await expect(page.getByTestId("profile-avatar-letters")).toHaveValue("");
    await expect(accountMenuAvatar(page)).toHaveText(AUTOMATIC);
    expect(browserErrors).toEqual([]);
  } finally {
    await setUserAvatar(DEV_EMAIL, { avatarLabel: null, avatarColor: null });
  }
});
