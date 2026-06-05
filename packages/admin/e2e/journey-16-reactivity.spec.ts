// Wave 1 reactivity journeys (doc-16 t-15). Each test exercises the path
// described in the Spec's §6 testing plan:
//   - doc-narrative-reactive: section edit propagates Tab A → Tab B.
//   - decision-reactive-via-mcp: decision resolution via API surface reaches
//     the open Spec's decision panel in a connected tab.
//   - task-reactive-via-agent: new task created via API surface reaches the
//     open Spec's task panel in a connected tab.
//   - reconnect-refetch: SSE stream is aborted; reconnect triggers a refetch
//     even before the new connection receives any event.
//
// The journeys use the doc-16-specific fixture in
// `./helpers/reactivity-fixtures.ts` because the legacy `./helpers/db.ts`
// targets the now-gone `accounts` schema. Each test seeds its own namespace +
// org + memex + Spec and cleans up on teardown.

import { test, expect, tenantPath, tenantApiUrl } from "./helpers/reactivity-fixtures.js";

test.describe("doc-16 Wave 1 reactivity journeys", () => {
  test("doc-narrative-reactive: section edit in Tab A propagates to Tab B", async ({
    browser,
    resources,
  }) => {
    const tenant = await resources.seedTenant("react-narr");
    const spec = await resources.seedSpec(
      tenant.memexId,
      "Reactive narrative",
      "Initial overview content.",
    );

    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const tabA = await ctxA.newPage();
    const tabB = await ctxB.newPage();

    await tabA.goto(tenantPath(tenant, `docs/${spec.docId}`));
    await tabB.goto(tenantPath(tenant, `docs/${spec.docId}`));

    await expect(tabA.getByText("Initial overview content.").first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(tabB.getByText("Initial overview content.").first()).toBeVisible({
      timeout: 15_000,
    });

    // Edit via API from tab A's request context — covers the canonical
    // mutate() → bus → SSE → useDocChangeStream → refetch path without
    // depending on the section editor's exact DOM affordances.
    const updateResp = await tabA.request.post(
      tenantApiUrl(tenant, `docs/sections/${spec.sectionId}`),
      {
        data: { content: "REACTIVE narrative updated content." },
        headers: { "Content-Type": "application/json" },
      },
    );
    expect(updateResp.ok()).toBeTruthy();

    // Tab B should pick up the change via SSE → useDocChangeStream → refetch.
    // 200ms debounce + network round-trip — generous timeout protects against CI flake.
    await expect(tabB.getByText("REACTIVE narrative updated content.").first()).toBeVisible({
      timeout: 15_000,
    });

    await ctxA.close();
    await ctxB.close();
  });

  test("decision-reactive-via-mcp: resolving a decision via API updates the open Spec's decisions panel", async ({
    browser,
    resources,
  }) => {
    const tenant = await resources.seedTenant("react-dec");
    const spec = await resources.seedSpec(
      tenant.memexId,
      "Reactive decisions",
      "Spec with decisions.",
    );

    // Seed one open decision via the REST surface so the response carries the
    // server-generated decision UUID. The decision's `created` event is for the
    // setup phase; the actual assertion is on the `updated` event from resolve.
    const ctxSeed = await browser.newContext();
    const seedPage = await ctxSeed.newPage();
    const createResp = await seedPage.request.post(
      tenantApiUrl(tenant, `decisions/doc/${spec.docId}`),
      {
        data: { title: "Which DB?", context: "Latency-sensitive workload." },
        headers: { "Content-Type": "application/json" },
      },
    );
    expect(createResp.ok()).toBeTruthy();
    const decision = await createResp.json();
    await ctxSeed.close();

    const ctx = await browser.newContext();
    const tab = await ctx.newPage();
    await tab.goto(tenantPath(tenant, `docs/${spec.docId}`));
    // The decisions panel only mounts when the Decisions tab is active. Click
    // it before asserting on the decision text.
    await tab.getByRole("button", { name: "Decisions", exact: true }).click();

    // Wait until the decision panel renders the seeded decision in its open state.
    await expect(tab.getByText("Which DB?").first()).toBeVisible({ timeout: 15_000 });

    // Resolve the decision via the REST surface (the MCP `resolve_decision`
    // tool calls the same service function — the bus emission is identical).
    const resolveResp = await tab.request.post(
      tenantApiUrl(tenant, `decisions/${decision.id}/resolve`),
      {
        data: { resolution: "Postgres it is." },
        headers: { "Content-Type": "application/json" },
      },
    );
    expect(resolveResp.ok()).toBeTruthy();

    // The decision panel should reflect the resolved state via SSE refetch.
    // Wait for the "1 resolved" counter to land (SSE delivered the event),
    // then click into the Resolved sub-tab to read the resolution body.
    await expect(tab.getByText("0 candidates, 0 open, 1 resolved")).toBeVisible({
      timeout: 15_000,
    });
    await tab.getByRole("button", { name: /Resolved\b/ }).click();
    await expect(tab.getByText("Postgres it is.").first()).toBeVisible({ timeout: 15_000 });

    await ctx.close();
  });

  test("task-reactive-via-agent: a new task created via API appears in the open Spec's task panel", async ({
    browser,
    resources,
  }) => {
    const tenant = await resources.seedTenant("react-task");
    const spec = await resources.seedSpec(
      tenant.memexId,
      "Reactive tasks",
      "Spec with tasks.",
    );

    const ctx = await browser.newContext();
    const tab = await ctx.newPage();
    await tab.goto(tenantPath(tenant, `docs/${spec.docId}`));
    // Activate the Tasks tab; the tasks panel only mounts when active.
    await tab.getByRole("button", { name: "Tasks", exact: true }).click();

    // Empty tasks panel — wait for the page to mount before mutating.
    await expect(tab.getByText("Reactive tasks").first()).toBeVisible({ timeout: 15_000 });

    // Create a task via the REST surface (the agent's `create_task` tool calls
    // the same `services/tasks.ts::createTask` function — the bus emission is identical).
    const taskTitle = `REACTIVE-TASK-${Date.now()}`;
    const createResp = await tab.request.post(
      tenantApiUrl(tenant, `tasks/doc/${spec.docId}`),
      {
        data: { title: taskTitle, description: "Created externally; tab should see it." },
        headers: { "Content-Type": "application/json" },
      },
    );
    expect(createResp.ok()).toBeTruthy();

    // Task should appear in the tasks panel without a manual refresh.
    await expect(tab.getByText(taskTitle).first()).toBeVisible({ timeout: 15_000 });

    await ctx.close();
  });

  test("reconnect-refetch: SSE stream re-establishment triggers a refetch even with no event on the new connection", async ({
    browser,
    resources,
  }) => {
    const tenant = await resources.seedTenant("react-recon");
    const spec = await resources.seedSpec(
      tenant.memexId,
      "Reactive reconnect",
      "Initial reconnect-test content.",
    );

    const ctx = await browser.newContext();
    const tab = await ctx.newPage();

    // 1. Allow the FIRST SSE connect to succeed so the hook flips
    //    `hasConnectedBefore` to true. Per dec-4 the refetch only fires on
    //    *re-establishment*, not first connect — so we need a clean first.
    await tab.goto(tenantPath(tenant, `docs/${spec.docId}`));
    await expect(tab.getByText("Initial reconnect-test content.").first()).toBeVisible({
      timeout: 15_000,
    });

    // Give the SSE its `ready` handshake + a small grace window so the
    // listener is fully wired before we drop network.
    await tab.waitForTimeout(500);

    // 2. Drop network. context.setOffline kills the open stream (reader.read
    //    rejects), so the hook exits the while loop and enters retry mode.
    await ctx.setOffline(true);

    // 3. Mutate while the tab can't observe events. The API request goes
    //    through Playwright's APIRequestContext, which bypasses the browser's
    //    offline mode — so the write actually lands.
    const updateResp = await tab.request.post(
      tenantApiUrl(tenant, `docs/sections/${spec.sectionId}`),
      {
        data: { content: "RECONNECT updated while disconnected." },
        headers: { "Content-Type": "application/json" },
      },
    );
    expect(updateResp.ok()).toBeTruthy();

    // Confirm the tab still shows the stale content (network down, no event
    // delivered to this client).
    await tab.waitForTimeout(500);
    await expect(tab.getByText("Initial reconnect-test content.").first()).toBeVisible();

    // 4. Restore network. The hook's exponential-backoff retry will succeed
    //    on the next attempt and — because hasConnectedBefore is true — the
    //    dec-4 reconnect-refetch rule fires a refetch the moment the new
    //    stream re-establishes, even before any event arrives on it.
    await ctx.setOffline(false);

    await expect(tab.getByText("RECONNECT updated while disconnected.").first()).toBeVisible({
      timeout: 30_000,
    });

    await ctx.close();
  });

  // Wave 2 — standards drift surfaces. The DriftInbox subscribes to the
  // per-Memex SSE stream; a `drift`-typed comment created in another tab (or
  // via MCP / agent) should bump the inbox in real time. The Wave 2 commit
  // also added a dedicated `standard_drift.created` emit so the StandardList
  // aggregate count can react without parsing comment payloads.
  test("drift-count-reactive: flagging drift on a standard section bumps the open Drift Inbox", async ({
    browser,
    resources,
  }) => {
    const tenant = await resources.seedTenant("react-drift");
    const standard = await resources.seedStandard(
      tenant.memexId,
      "Reactive standard",
      "A rule.",
    );

    const ctx = await browser.newContext();
    const tab = await ctx.newPage();
    await tab.goto(tenantPath(tenant, "drift"));

    // Fresh inbox — no drift items yet.
    await expect(tab.getByRole("heading", { name: "Drift Inbox" }).first()).toBeVisible({
      timeout: 15_000,
    });

    // Flag drift on the standard's section via the comment REST surface
    // (type='drift'). addComment fires comment.created on the bus; the
    // DriftInbox refetches on every per-Memex event and re-counts open
    // drift+plan_revision rows.
    const driftBody = `drift-observation-${Date.now()}`;
    const flagResp = await tab.request.post(
      tenantApiUrl(tenant, `comments/section/${standard.sectionId}`),
      {
        data: {
          authorName: "E2E Reactivity",
          content: driftBody,
          type: "drift",
          source: "agent",
        },
        headers: { "Content-Type": "application/json" },
      },
    );
    expect(flagResp.ok()).toBeTruthy();

    // The drift observation should appear in the inbox without a manual refresh.
    await expect(tab.getByText(driftBody).first()).toBeVisible({ timeout: 15_000 });

    await ctx.close();
  });

  // Wave 3 — MemexSwitcher reactivity. When the signed-in user creates a new
  // org from another channel, the AuthContext receives a memex.created /
  // org.created / org_membership.created event on /api/me/events (filtered by
  // userId), refetches /api/auth/me, and the switcher dropdown reflects the
  // new org without a page reload.
  test("memex-switcher-reactive: creating a new org adds it to the open MemexSwitcher dropdown", async ({
    browser,
    resources,
  }) => {
    const tenant = await resources.seedTenant("react-mxsw");

    const ctx = await browser.newContext();
    const tab = await ctx.newPage();
    await tab.goto(tenantPath(tenant, "specs"));

    // Wait for the switcher trigger to appear (it sits in the header and
    // shows the current tenant's name).
    await expect(tab.getByTitle("Switch Memex").first()).toBeVisible({ timeout: 15_000 });
    await tab.getByTitle("Switch Memex").first().click();

    // Initial state: one org membership in the dropdown (the seeded tenant).
    await expect(tab.getByText("Your orgs").first()).toBeVisible();

    // Create a new org via the REST surface. The session middleware in dev
    // mode resolves the dev user automatically; createOrgWithOwner emits a
    // composite (memex/org/user_namespace/org_membership) with userId set,
    // which /api/me/events delivers, which refetches the session.
    const newOrgSlug = `react-mxsw-new-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 6)}`.toLowerCase();
    const createResp = await tab.request.post("http://localhost:8090/api/orgs", {
      data: { slug: newOrgSlug, name: `New Org ${newOrgSlug}` },
      headers: { "Content-Type": "application/json" },
    });
    expect(createResp.ok()).toBeTruthy();

    // The new org's name should appear in the dropdown without a manual
    // reload. AuthContext refetched the session via the user-events SSE; the
    // switcher reads `session.memberships` and re-renders.
    await expect(tab.getByText(`New Org ${newOrgSlug}`).first()).toBeVisible({
      timeout: 15_000,
    });

    await ctx.close();
  });

  // Wave 3 — Share modal reactivity. When a share token is revoked from
  // another channel, the open ShareModal subscribes to the per-doc SSE
  // stream and refetches its token list, so the revoked link disappears
  // without a manual reload.
  test("share-token-reactive: revoking a share token elsewhere removes it from the open ShareModal", async ({
    browser,
    resources,
  }) => {
    const tenant = await resources.seedTenant("react-share");
    const spec = await resources.seedSpec(
      tenant.memexId,
      "Reactive share",
      "Spec for share reactivity.",
    );

    const ctx = await browser.newContext();
    const tab = await ctx.newPage();
    await tab.goto(tenantPath(tenant, `docs/${spec.docId}`));
    await expect(tab.getByText("Reactive share").first()).toBeVisible({ timeout: 15_000 });

    // Create a share token via REST so the modal has something to show.
    const createResp = await tab.request.post(
      tenantApiUrl(tenant, `docs/${spec.docId}/share`),
      { data: {}, headers: { "Content-Type": "application/json" } },
    );
    expect(createResp.ok()).toBeTruthy();
    const share = (await createResp.json()) as { id: string; token: string };

    // Open the Share modal. The toolbar "Share" button is a "coming soon"
    // placeholder; the real ShareModal opens from the per-doc Actions menu.
    await tab.getByRole("button", { name: /Actions for /, exact: false }).click();
    await tab.getByRole("menuitem", { name: "Share", exact: true }).click();
    await expect(tab.getByRole("heading", { name: "Share this document" })).toBeVisible({
      timeout: 5_000,
    });

    // The just-created token should appear in the list. Match the share URL
    // suffix since the modal renders the full bareDomainUrl.
    await expect(tab.getByText(new RegExp(`/share/${share.token}`)).first()).toBeVisible({
      timeout: 15_000,
    });

    // Give the modal's useDocChangeStream a moment to establish the SSE
    // connection so the upcoming revoke's bus event isn't lost.
    await tab.waitForTimeout(400);

    // Revoke the token from a separate channel — the open modal should
    // refetch via useDocChangeStream when share_token.updated fires.
    const revokeResp = await tab.request.delete(
      tenantApiUrl(tenant, `docs/shares/${share.id}`),
    );
    expect(revokeResp.ok()).toBeTruthy();

    // Modal renders "No active share links" once the revoked token drops off.
    await expect(
      tab.getByText("No active share links. Click \"New share link\" to create one."),
    ).toBeVisible({ timeout: 15_000 });

    await ctx.close();
  });
});
