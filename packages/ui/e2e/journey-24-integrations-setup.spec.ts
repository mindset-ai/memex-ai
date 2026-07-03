import { test, expect, bareUrl, emitAcEvents } from "./helpers/index.js";

// Journey 24 — Integrations setup surface (spec-201 + spec-452, std-28 gate).
//
// SCOPE: the consolidated /settings/integrations page is the single discoverable
// surface for BOTH connecting an agent and installing the AC emitter. spec-452
// collapsed the two overlapping "paste a prompt" surfaces (spec-201's genesis toggle
// + spec-430's CLI install-prompt button) into ONE tabbed, per-client surface. This
// journey proves that end-to-end in a real browser — route → React → rendered page →
// live tab interaction + clipboard — which the jsdom suites can't.
//
// Emits spec-201 scope ACs (ac-1/ac-2) and spec-452 scope ACs (ac-1/ac-2/ac-5/ac-6);
// the AC-emitter section still emits spec-201 ac-3/ac-4 (TEST_2).

const AC201 = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-201/acs/ac-${n}`;
const AC452 = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-452/acs/ac-${n}`;

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
  "one tabbed per-client setup surface: five tabs from one source, switching swaps the prompt, no duplicate CTA, manual fallback reachable (spec-201 ac-1/ac-2; spec-452 ac-1/ac-2/ac-5/ac-6)";
ACS_BY_TEST[TEST_1] = [AC201(1), AC201(2), AC452(1), AC452(2), AC452(5), AC452(6)];

test(TEST_1, async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

  // std-28: path-based nav. The route is top-level + member-visible.
  await page.goto(bareUrl("/settings/integrations"));
  await expect(
    page.getByRole("heading", { name: "Integrations", level: 1 }),
  ).toBeVisible({ timeout: 15_000 });

  const setup = page.locator("#install-memex");

  // spec-452 ac-1: exactly ONE setup surface. The merged section is present…
  await expect(setup.getByRole("heading", { name: "Set up Memex" })).toBeVisible();
  // …and install-the-emitter content lives on the same page (spec-201 ac-1).
  await expect(page.getByRole("heading", { name: "Install the AC emitter" })).toBeVisible();
  // …and the old duplicate surfaces / CTA are GONE (the dissonance spec-452 removed).
  await expect(page.getByRole("heading", { name: "Set up with one prompt" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: /copy install prompt for claude code/i }),
  ).toHaveCount(0);

  // spec-452 ac-2 / spec-201 ac-2: all five clients are named as tabs, and the default
  // Claude Code tab shows the unified-install prompt.
  for (const label of [
    "Claude Code",
    "Cursor",
    "Copilot (VS Code)",
    "Claude Desktop",
    "Claude.ai (web)",
  ]) {
    await expect(setup.getByRole("tab", { name: label })).toBeVisible();
  }
  const promptCode = setup.locator("pre code").first();
  await expect(promptCode).toContainText("npx -y memex-ai install");
  await expect(promptCode).toContainText("CLAUDE.md");

  // spec-452 ac-2: switching the tab swaps the prompt to that client's memory-file target.
  await setup.getByRole("tab", { name: "Cursor" }).click();
  await expect(setup.locator("pre code").first()).toContainText(".cursor/rules/memex.mdc");
  await setup.getByRole("tab", { name: "Copilot (VS Code)" }).click();
  await expect(setup.locator("pre code").first()).toContainText(".github/copilot-instructions.md");

  // spec-201 ac-2: the env-derived MCP URL (a real http(s) URL ending in /mcp) reaches the
  // browser — read it off the web tab, which shows the bare URL.
  await setup.getByRole("tab", { name: "Claude.ai (web)" }).click();
  const mcpUrlText = (await setup.locator("pre code").first().textContent())?.trim();
  expect(mcpUrlText).toMatch(/^https?:\/\/.+\/mcp$/);

  // spec-201 ac-2: copy controls are live — clicking Copy writes to the clipboard and the
  // control confirms ("Copied!"). Proves the real clipboard path, not just markup.
  const copyBtn = setup.getByRole("button", { name: "Copy", exact: true }).first();
  await copyBtn.click();
  await expect(setup.getByRole("button", { name: "Copied!" }).first()).toBeVisible();

  // spec-452 ac-5: the manual "run it yourself" fallback is reachable (secondary, collapsed
  // by default) on a coding-agent tab.
  await setup.getByRole("tab", { name: "Cursor" }).click();
  await setup.getByRole("button", { name: /show manual setup/i }).click();
  await expect(setup.getByText(/Prefer to edit config directly/)).toBeVisible();
});

const TEST_2 =
  "the AC-emitter section installs from the shared adapter matrix — command, key, Emission Keys deep link, tagAc example (ac-3 / ac-4)";
ACS_BY_TEST[TEST_2] = [AC201(3), AC201(4)];

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
