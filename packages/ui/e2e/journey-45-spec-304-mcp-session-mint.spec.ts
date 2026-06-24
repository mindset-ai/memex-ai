import { test, expect, emitAcEvents } from "./helpers/index.js";

// Journey 45 — spec-304 t-13 (std-28, ac-28): the desktop app's in-app "Install
// MCP" flow is session-minted. The native installMcp bridge only exists inside
// the Flutter webview (it cannot be driven from a browser), so the part this
// PR-gate journey owns is the SESSION-MINT: a logged-in web session mints an MCP
// token via POST /api/mcp/tokens — no terminal, no CLI device flow — and that
// token is a real, persisted token exposing only its safe prefix. (The bridge
// handoff itself is covered desktop-side by memex-clients' installMcp tests.)
//
// Unlike the server integration test (which hits Hono in-process), this drives
// the request through the running app's real HTTP surface: the UI origin's /api
// proxy → the live server, the same path the embedded webview uses in dev mode.

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-304/acs/ac-${n}`;
const API_URL = process.env.E2E_API_URL ?? "http://localhost:8090";

test.afterEach(async ({}, testInfo) => {
  await emitAcEvents(
    [AC(28)],
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-45-spec-304-mcp-session-mint.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test("a logged-in session mints an MCP token with no device flow, and it persists as a safe-prefixed token", async ({
  page,
}) => {
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
