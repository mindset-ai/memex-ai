import { test, expect, bareUrl, emitAcEvents } from "./helpers/index.js";

// Journey 45 — spec-304 t-13 + t-55 (std-28): the desktop app's in-app "Install
// Memex MCP" flow.
//
//  • t-13 (ac-28): the SESSION-MINT — a logged-in web session mints an MCP token
//    via POST /api/mcp/tokens with no terminal / CLI device flow, persisted as a
//    real token exposing only its safe prefix.
//  • t-55 (ac-6 / ac-4 / ac-45): the IN-APP INSTALL UI — inside the desktop shell
//    the DesktopMcpSection renders, mints from the live session, and hands the
//    raw token to the native installMcp bridge (never showing it). The Flutter
//    bridge only exists in the embedded webview, so here we STUB
//    window.flutter_inappwebview to record the handoff and drive the React flow
//    end-to-end against the running app; the native write itself is covered
//    desktop-side by memex-clients' installMcp tests.

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-304/acs/ac-${n}`;
const API_URL = process.env.E2E_API_URL ?? "http://localhost:8090";

const ACS_BY_TEST: Record<string, string[]> = {};

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  const acRefs = ACS_BY_TEST[testInfo.title] ?? [];
  if (acRefs.length === 0) return;
  await emitAcEvents(
    acRefs,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-45-spec-304-mcp-session-mint.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

const MINT_TEST =
  "a logged-in session mints an MCP token with no device flow, and it persists as a safe-prefixed token";
ACS_BY_TEST[MINT_TEST] = [AC(28)];

test(MINT_TEST, async ({ page }) => {
  const label = `Desktop e2e ${Date.now()}`;

  // The session-mint under test, through the running app's HTTP surface (the
  // dev-mode session resolves the dev user, exactly as the desktop webview's
  // already-authenticated session would).
  const mint = await page.request.post(`${API_URL}/api/mcp/tokens`, {
    headers: { "Content-Type": "application/json" },
    data: { label },
  });
  expect(mint.status()).toBe(201);
  const minted = await mint.json();
  expect(minted.token).toMatch(/^mxt_/);
  expect(minted.label).toBe(label);
  expect(minted.prefix.startsWith("mxt_")).toBe(true);

  // It's a real, persisted token: the list endpoint surfaces it by id with only
  // the safe prefix — never the raw secret that was returned once at mint time.
  const list = await page.request.get(`${API_URL}/api/mcp/tokens`);
  expect(list.status()).toBe(200);
  const tokens: Array<{ id: string; label: string; prefix: string }> = await list.json();
  const found = tokens.find((t) => t.id === minted.id);
  expect(found).toBeTruthy();
  expect(found?.label).toBe(label);
  expect(found?.prefix.startsWith("mxt_")).toBe(true);
  // The list never echoes the raw secret back.
  expect(JSON.stringify(found)).not.toContain(minted.token);
});

const INSTALL_TEST =
  "inside the desktop shell, Install mints from the session and hands the token to the native bridge — never shown";
ACS_BY_TEST[INSTALL_TEST] = [AC(6), AC(4), AC(45)];

test(INSTALL_TEST, async ({ page }) => {
  // Stub the Flutter bridge BEFORE any page script runs so isDesktopShell() is
  // true and DesktopMcpSection renders. callHandler records every call and
  // returns canned native results; the recorded calls let us assert the token
  // handoff without a real Flutter runtime.
  await page.addInitScript(() => {
    const calls: Array<{ name: string; args: unknown }> = [];
    (window as unknown as { __bridgeCalls: typeof calls }).__bridgeCalls = calls;
    (window as unknown as { flutter_inappwebview: unknown }).flutter_inappwebview = {
      callHandler: (name: string, args: unknown) => {
        calls.push({ name, args });
        switch (name) {
          case "mcpStatus":
            return {
              ok: true,
              targets: {
                claudeCode: { installed: false, urlMatches: false, tokenPrefix: null },
                claudeDesktop: { installed: false, urlMatches: false, tokenPrefix: null },
              },
            };
          case "installMcp":
            return {
              ok: true,
              name: "Claude Code",
              path: "/home/dev/.claude.json",
              backupPath: "/home/dev/.claude.json.bak",
            };
          default:
            return { ok: true };
        }
      },
    };
  });

  // Intercept the session-mint POST so the UI flow is deterministic and isn't
  // coupled to live in-page POST timing (test 1 above already covers the REAL
  // /api/mcp/tokens endpoint end-to-end). GET/other methods hit the real server.
  // This still proves the UI mints via the session endpoint (the route fires),
  // then routes the raw token to the native bridge — never the DOM.
  const MINTED = "mxt_e2e0token0123456789abcdef";
  let mintPosted = false;
  await page.route("**/api/mcp/tokens", async (route) => {
    if (route.request().method() === "POST") {
      mintPosted = true;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          token: MINTED,
          id: "tok_e2e",
          label: "Memex Desktop",
          prefix: MINTED.slice(0, 12),
          createdAt: "2026-06-27T00:00:00.000Z",
        }),
      });
    } else {
      await route.continue();
    }
  });

  await page.goto(bareUrl("/settings/integrations"));

  // The in-app install surface is present (desktop-shell only).
  await expect(
    page.getByRole("heading", { name: "Install Memex MCP on this device" }),
  ).toBeVisible({ timeout: 15_000 });

  const codeRow = page.getByTestId("mcp-client-claudeCode");
  await expect(codeRow).toBeVisible();

  // A never-installed client reads "Not installed" with an Install action.
  await expect(page.getByTestId("mcp-status-claudeCode")).toHaveText("Not installed");
  await codeRow.getByRole("button", { name: "Install" }).click();

  // Success surfaces a restart prompt (ac-7's user-facing instruction).
  await expect(page.getByRole("status")).toContainText("Restart Claude Code", {
    timeout: 15_000,
  });

  // The token came from the session-mint endpoint (no terminal / device flow).
  expect(mintPosted).toBe(true);

  // The flow handed the RAW minted token to installMcp — and it never appeared
  // in the DOM (ac-6).
  const calls = await page.evaluate(
    () => (window as unknown as { __bridgeCalls: Array<{ name: string; args: { token?: string } }> }).__bridgeCalls,
  );
  const install = calls.find((c) => c.name === "installMcp");
  expect(install).toBeTruthy();
  expect(install?.args.token).toMatch(/^mxt_/);
  expect(install?.args.token?.length).toBeGreaterThan(12);

  const rawToken = install!.args.token!;
  expect(await page.content()).not.toContain(rawToken);
  // Success was announced natively (dec-22 / ac-51).
  expect(calls.some((c) => c.name === "showNotification")).toBe(true);
});
