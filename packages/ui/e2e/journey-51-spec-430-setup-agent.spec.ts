import {
  test,
  expect,
  bareUrl,
  emitAcEvents,
  ensureUser,
  setUserName,
  setIdentityConfirmed,
  DEV_EMAIL,
  DEV_NAME,
} from "./helpers/index.js";

// Journey 51 — spec-430: the NEW coding-agent install flow (std-28 gate).
//
// SCOPE: the consolidated /settings/integrations "Install Memex MCP" surface now
// describes the unified Claude Code install — ONE browser sign-in via
// `npx -y memex-ai install` plants the Memex MCP token AND mints the single
// per-user checkout key (no second sign-in, no per-memex keys, nothing pasted by
// hand) — followed by the HOOKS-ONLY spec-checkout plugin added with
// `claude plugin …`. That plugin is CLAUDE-CODE-ONLY: it must NOT appear in the
// OAuth-on-connect "Other clients" (Cursor / VS Code / web) guidance.
//
// This proves the manager-authored outcome end-to-end in a real browser
// (route → React → rendered page → live copy) which the jsdom component suites
// (CliInstallSection.test.tsx / ConnectAgentStep.test.tsx) can't: real path-based
// navigation and the install copy/commands as they actually reach the browser.
//
// Static copy only — nothing here runs the bootstrap (the pasted agent does that),
// so there is no live MCP/OAuth dance to drive (same posture as journey-24).
//
// Emits spec-430 ac-9 via the emitAcEvents afterEach hook (pass+fail alike).

const FILE = "packages/ui/e2e/journey-51-spec-430-setup-agent.spec.ts";
const AC9 = "mindset-prod/memex-building-itself/specs/spec-430/acs/ac-9";

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    [AC9],
    testInfo.status === "passed" ? "pass" : "fail",
    `${FILE}::${testInfo.title}`,
    testInfo.duration,
  );
});

test("Claude Code install describes the unified npx install + the Claude-Code-only checkout plugin, gated out of the other-clients block (spec-430 ac-9)", async ({
  page,
}) => {
  // Shared dev user, identity-confirmed so the app routes straight to the surface.
  await ensureUser(DEV_EMAIL);
  await setUserName(DEV_EMAIL, DEV_NAME);
  await setIdentityConfirmed(DEV_EMAIL, true);

  // std-28: path-based nav. The Integrations route is top-level + member-visible.
  await page.goto(bareUrl("/settings/integrations"));
  await expect(
    page.getByRole("heading", { name: "Integrations", level: 1 }),
  ).toBeVisible({ timeout: 15_000 });

  const cli = page.locator("#install-cli");
  await expect(cli.getByRole("heading", { name: "Install Memex MCP" })).toBeVisible();

  // The Claude Code path is its own block — select/scope to it.
  await expect(cli.getByRole("heading", { name: "Claude Code", exact: true })).toBeVisible();

  // ac-9: the unified installer — ONE browser sign-in → MCP token + checkout key.
  await expect(cli.getByText(/npx -y memex-ai install/).first()).toBeVisible();
  // …and the HOOKS-ONLY, Claude-Code-only spec-checkout plugin steps.
  await expect(
    cli.getByText("claude plugin marketplace add mindset-ai/memex-ai"),
  ).toBeVisible();
  await expect(
    cli.getByText("claude plugin install memex-checkout@memex"),
  ).toBeVisible();

  // ac-9: the old curl/irm install.sh bootstrap one-liner is gone (superseded).
  await expect(cli.getByText(/install\.sh|install\.ps1/)).toHaveCount(0);

  // ac-9 (the gate): the checkout plugin is CLAUDE-CODE-ONLY — it must NOT appear in
  // the OAuth-on-connect "Other clients" (Cursor / VS Code / web) guidance, which
  // stays MCP-only over the env-derived URL.
  const others = page.locator("#other-clients");
  await expect(others).toBeVisible();
  await expect(others.getByText(/memex-checkout/)).toHaveCount(0);
  await expect(others.getByText(/claude plugin/)).toHaveCount(0);
  // The other-clients block still carries the env-derived MCP URL (a real http(s)
  // URL ending in /mcp), not the plugin commands.
  const mcpUrlText = (
    await others.locator("pre code").first().textContent()
  )?.trim();
  expect(mcpUrlText).toMatch(/^https?:\/\/.+\/mcp$/);
});
