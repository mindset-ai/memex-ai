import { test, expect, bareUrl } from "./helpers/fixtures.js";
import { clearUserName } from "./helpers/db.js";

// Journey 1: New account creation (GitHub-style model)
// A signed-in user lands on their PERSONAL memex at the bare domain. From the memex
// switcher dropdown in the header they can "Create a new memex", pick a subdomain, and
// get redirected to the new team's subdomain. There is no separate "Signup" screen.
//
// In dev mode AuthContext skips Google login entirely and treats the visitor as dev@memex.ai.
// The fixture auto-provisions dev's personal account + sets a display name so no onboarding.

test("new user lands on personal, creates a team via switcher, and is redirected to the team", async ({
  page,
  resources,
}) => {
  const subdomain = resources.subdomain("j1");

  // Clear the dev user's name so the onboarding screen is triggered first.
  await clearUserName("dev@memex.ai");

  await page.goto(bareUrl("/"));

  // Onboarding: set display name
  await expect(page.getByText(/What's your name/i)).toBeVisible({ timeout: 10_000 });
  await page.getByPlaceholder("Your display name").fill("Test User");
  await page.getByRole("button", { name: /Continue/i }).click();

  // After onboarding the user lands on their personal memex at the bare domain. The
  // header switcher should render "Personal Memex" as the current context.
  await expect(
    page.getByRole("button", { name: /Personal Memex/i })
  ).toBeVisible({ timeout: 10_000 });

  // Open the switcher and click "Create a new memex"
  await page.getByRole("button", { name: /Personal Memex/i }).click();
  await page.getByRole("button", { name: /Create a new memex|Create memex/i }).first().click();

  // Dialog opens with the subdomain form (dev user's email is auto-verified on sign-in,
  // so the verification gate doesn't block team creation).
  const input = page.getByPlaceholder("acme");
  await expect(input).toBeVisible({ timeout: 5000 });
  await input.fill(subdomain);
  await expect(page.getByText(/Available/i)).toBeVisible({ timeout: 5000 });

  // Submit inside the dialog → backend creates the team + admin membership, client redirects
  // to `<subdomain>.localhost:5173`. Use the dialog's primary button (not the switcher menu
  // item of the same label) by scoping to the form's submit button.
  const navigationPromise = page.waitForURL(
    (url) => url.hostname.startsWith(`${subdomain}.`),
    { timeout: 15000 }
  );
  await page
    .getByRole("button", { name: /^Create memex$/i })
    .click();
  await navigationPromise;

  await expect(page).toHaveURL(new RegExp(`^https?://${subdomain}\\.`));

  // Track the new account for cleanup
  const postgres = (await import("postgres")).default;
  const client = postgres(
    process.env.E2E_DATABASE_URL ??
      "postgresql://postgres:postgres@localhost:5432/memex"
  );
  try {
    const rows = await client<{ id: string; kind: string }[]>`
      SELECT id, kind FROM accounts WHERE subdomain = ${subdomain} LIMIT 1
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("team");
    resources.accountIds.push(rows[0].id);
  } finally {
    await client.end();
  }
});

test("returning user skips onboarding and can create a team from the switcher", async ({
  page,
  resources,
}) => {
  const subdomain = resources.subdomain("j1r");

  // Dev user already has a name set (fixture default) and only their personal memex —
  // they land on personal and can create a team from the header switcher.
  await page.goto(bareUrl("/"));
  await expect(
    page.getByRole("button", { name: /Personal Memex/i })
  ).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: /Personal Memex/i }).click();
  await page.getByRole("button", { name: /Create a new memex|Create memex/i }).first().click();

  await page.getByPlaceholder("acme").fill(subdomain);
  await expect(page.getByText(/Available/i)).toBeVisible({ timeout: 5000 });

  const navigationPromise = page.waitForURL(
    (url) => url.hostname.startsWith(`${subdomain}.`),
    { timeout: 15000 }
  );
  await page
    .getByRole("button", { name: /^Create memex$/i })
    .click();
  await navigationPromise;

  await expect(page).toHaveURL(new RegExp(`^https?://${subdomain}\\.`));

  // Cleanup
  const postgres = (await import("postgres")).default;
  const client = postgres(
    process.env.E2E_DATABASE_URL ??
      "postgresql://postgres:postgres@localhost:5432/memex"
  );
  try {
    const rows = await client<{ id: string }[]>`
      SELECT id FROM accounts WHERE subdomain = ${subdomain} LIMIT 1
    `;
    expect(rows).toHaveLength(1);
    resources.accountIds.push(rows[0].id);
  } finally {
    await client.end();
  }
});
