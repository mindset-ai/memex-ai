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

// Journey 51 — spec-430 + spec-452: the coding-agent install flow (std-28 gate).
//
// SCOPE: on the consolidated /settings/integrations "Set up Memex" surface (spec-452's
// one tabbed, per-client section), the Claude Code tab describes the unified install —
// ONE browser sign-in via `npx -y memex-ai install` plants the MCP token AND mints the
// checkout key — followed by the HOOKS-ONLY, CLAUDE-CODE-ONLY spec-checkout plugin. That
// plugin must NOT appear on the Cursor or Copilot tabs (they're MCP-only over OAuth), and
// Copilot targets VS Code agent mode (`.vscode/mcp.json` + copilot-instructions), never a
// cloud-agent / PAT flow.
//
// Emits spec-430 ac-9 and spec-452 ac-3 (prompts register + write clause; plugin CC-only)
// and ac-4 (Copilot = VS Code agent mode).

const FILE = "packages/ui/e2e/journey-51-spec-430-setup-agent.spec.ts";
const AC9 = "mindset-prod/memex-building-itself/specs/spec-430/acs/ac-9";
const AC452 = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-452/acs/ac-${n}`;

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    [AC9, AC452(3), AC452(4)],
    testInfo.status === "passed" ? "pass" : "fail",
    `${FILE}::${testInfo.title}`,
    testInfo.duration,
  );
});

test("Claude Code tab = unified npx install + the Claude-Code-only checkout plugin, gated out of the Cursor/Copilot tabs; Copilot targets VS Code agent mode (spec-430 ac-9; spec-452 ac-3/ac-4)", async ({
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

  const setup = page.locator("#install-memex");
  await expect(setup.getByRole("heading", { name: "Set up Memex" })).toBeVisible();

  // spec-430 ac-9 / spec-452 ac-3: the Claude Code tab (default) drives the unified
  // installer AND the hooks-only, Claude-Code-only spec-checkout plugin — all in one
  // pasteable prompt that also writes the CLAUDE.md clause.
  const ccPrompt = setup.locator("pre code").first();
  await expect(ccPrompt).toContainText("npx -y memex-ai install");
  await expect(ccPrompt).toContainText("claude plugin marketplace add mindset-ai/memex-ai");
  await expect(ccPrompt).toContainText("claude plugin install memex-checkout@memex");
  await expect(ccPrompt).toContainText("CLAUDE.md");
  // The old curl/irm install.sh bootstrap one-liner is gone (superseded).
  await expect(setup.getByText(/install\.sh|install\.ps1/)).toHaveCount(0);

  // spec-452 ac-3 (the gate): the checkout plugin is CLAUDE-CODE-ONLY — the Cursor tab is
  // MCP-only, no plugin.
  await setup.getByRole("tab", { name: "Cursor" }).click();
  const cursorPrompt = setup.locator("pre code").first();
  await expect(cursorPrompt).toContainText(".cursor/mcp.json");
  await expect(cursorPrompt).not.toContainText("claude plugin");
  await expect(cursorPrompt).not.toContainText("memex-checkout");

  // spec-452 ac-4: Copilot targets VS Code AGENT MODE — `.vscode/mcp.json` +
  // `.github/copilot-instructions.md`, OAuth on connect. No plugin, no cloud-agent / PAT.
  await setup.getByRole("tab", { name: "Copilot (VS Code)" }).click();
  const copilotPrompt = setup.locator("pre code").first();
  await expect(copilotPrompt).toContainText(".vscode/mcp.json");
  await expect(copilotPrompt).toContainText(".github/copilot-instructions.md");
  await expect(copilotPrompt).not.toContainText("claude plugin");
  await expect(copilotPrompt).not.toContainText("personal access token");
});
