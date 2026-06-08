import { test, expect, bareUrl, emitAcEvents } from "./helpers/index.js";

// Journey 24 — Integrations setup surface (spec-201, std-28 gate).
//
// SCOPE: the consolidated /settings/integrations page is the single discoverable
// surface for BOTH connecting an agent and installing the AC emitter. This is the
// std-28 e2e gate for spec-201; it proves the manager-authored scope outcomes
// end-to-end in a real browser — route → React → rendered page → live
// interaction — which the jsdom component suites (SettingsIntegrations.test.tsx)
// can't: real path-based navigation, the environment-derived MCP URL as it
// actually resolves in the running app, a real clipboard write, and the live
// tab/row interactions.
//
// Emits the spec-201 SCOPE ACs only (ac-1..ac-4) — the page-level outcomes.
// The implementation ACs (ac-6..ac-21) stay covered by the component suites.
//
// Static copy only (ac-21): nothing here runs the bootstrap — the pasted agent
// does that. So there is no live MCP/OAuth dance to drive (same posture as the
// claude.ai/Cursor connect steps, which complete sign-in off-platform).

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-201/acs/ac-${n}`;

// Per-test scope-AC mapping (each test proves a distinct slice of the surface).
const ACS_BY_TEST: Record<string, string[]> = {};

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  const acRefs = ACS_BY_TEST[testInfo.title] ?? [];
  if (acRefs.length === 0) return;
  await emitAcEvents(
    acRefs,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-24-integrations-setup.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

const TEST_1 =
  "one discoverable surface: connect-an-agent + install-emitter, with the env-derived MCP URL, live copy, and per-client steps (ac-1 / ac-2)";
ACS_BY_TEST[TEST_1] = [AC(1), AC(2)];

test(TEST_1, async ({ page }) => {
  // Real clipboard write needs the permission granted in headless chromium;
  // without it navigator.clipboard.writeText rejects and the button never flips.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

  // std-28: path-based nav. The route is top-level + member-visible.
  await page.goto(bareUrl("/settings/integrations"));
  await expect(
    page.getByRole("heading", { name: "Integrations", level: 1 }),
  ).toBeVisible({ timeout: 15_000 });

  // ac-1: BOTH connect-an-agent content…
  await expect(page.getByRole("heading", { name: "Install Memex MCP" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Set up with one prompt" })).toBeVisible();
  // …and install-the-emitter content live on the same surface.
  await expect(page.getByRole("heading", { name: "Install the AC emitter" })).toBeVisible();

  // ac-2: all four connect clients are named on the surface.
  const cli = page.locator("#install-cli");
  await expect(cli.getByRole("heading", { name: "claude.ai (web)" })).toBeVisible();
  await expect(cli.getByRole("heading", { name: "Cursor", exact: true })).toBeVisible();
  await expect(cli.getByText(/Claude Code/).first()).toBeVisible();
  await expect(cli.getByText(/Claude Desktop/).first()).toBeVisible();

  // ac-2: the MCP URL shown is the ENV-DERIVED one (a real http(s) URL ending
  // in /mcp), not a hardcoded host. The exact per-env derivation is pinned by
  // mcpUrl.test.ts; here we prove a derived URL actually reaches the browser.
  const mcpUrlText = (
    await page.locator("#other-clients pre code").first().textContent()
  )?.trim();
  expect(mcpUrlText).toMatch(/^https?:\/\/.+\/mcp$/);

  // ac-2: copy controls are live — clicking Copy writes to the clipboard and the
  // control confirms ("Copied!"). Proves the real clipboard path, not just markup.
  const copyBtn = cli.getByRole("button", { name: "Copy" }).first();
  await copyBtn.click();
  await expect(cli.getByRole("button", { name: "Copied!" }).first()).toBeVisible();

  // ac-2: the genesis "Set up with one prompt" step is per-client and interactive
  // — switching the agent tab swaps the memory-file target the prompt writes to.
  const genesis = page.locator("#genesis-prompt");
  await expect(genesis).toContainText("CLAUDE.md");
  await genesis.getByRole("tab", { name: "Cursor" }).click();
  await expect(genesis).toContainText(".cursor/rules/memex.mdc");
});

const TEST_2 =
  "the AC-emitter section installs from the shared adapter matrix — command, key, Emission Keys deep link, tagAc example (ac-3 / ac-4)";
ACS_BY_TEST[TEST_2] = [AC(3), AC(4)];

test(TEST_2, async ({ page }) => {
  await page.goto(bareUrl("/settings/integrations"));
  await expect(
    page.getByRole("heading", { name: "Install the AC emitter" }),
  ).toBeVisible({ timeout: 15_000 });

  // ac-4: the adapter matrix is data-sourced from the shared manifest — one row
  // per shipped adapter. (Manifest drift is guarded by AcEmitterSection.test.tsx;
  // here we assert the matrix actually renders every adapter in the browser.)
  const matrix = page.getByRole("table", { name: "AC emitter adapters" });
  await expect(matrix).toBeVisible();
  await expect(matrix.getByRole("row")).toHaveCount(4);
  for (const pkg of [
    "@memex-ai-ac/vitest",
    "memex-ai-ac-pytest",
    "@memex-ai-ac/jest",
    "github.com/mindset-ai/memex-ai-ac-go",
  ]) {
    await expect(matrix.getByText(pkg, { exact: true })).toBeVisible();
  }
  // ac-4: per-adapter statuses are shown, and a non-available adapter is
  // non-selectable (the row button is disabled).
  await expect(matrix.getByText("Available").first()).toBeVisible();
  await expect(matrix.getByText("Coming soon")).toBeVisible();
  await expect(matrix.getByRole("row", { name: /pytest/ })).toBeDisabled();

  // ac-3: the install instructions for the default (available) adapter — the
  // command, the MEMEX_EMIT_KEY step, the Emission Keys deep link, the tagAc
  // example — are all present on the surface.
  const emitter = page.locator("#install-ac-emitter");
  await expect(
    emitter.getByText("npm install --save-dev @memex-ai-ac/vitest"),
  ).toBeVisible();
  await expect(emitter.getByText(/MEMEX_EMIT_KEY=/)).toBeVisible();
  await expect(emitter.getByRole("link", { name: "Emission Keys" })).toBeVisible();
  // `tagAc('` (with the quote) is the tagged-test example in the code block; the
  // bare `tagAc()` in the prose above is a separate match, so anchor on the quote
  // to stay unambiguous.
  await expect(
    emitter.getByText("tagAc('your-namespace/your-memex/specs/spec-1/acs/ac-1')"),
  ).toBeVisible();
});
