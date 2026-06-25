import { test, expect, tenantPath } from "./helpers/index.js";
import {
  getPersonalMemexByEmail,
  ensureUser,
  seedSpecInMemex,
  deleteDoc,
  emitAcEvents,
} from "./helpers/index.js";
import type { Request } from "@playwright/test";

// std-28 PR-gate journey for spec-407 — the bulk presence read.
//
// The Pulse "Working now" zone used to ask "who's here?" once PER SPEC, fanning
// out one GET /presence?ref=<spec> per spec on every poll (~366 on the largest
// workspace, the production CPU incident). spec-407 collapses that to ONE
// whole-workspace GET /presence (no ref) per poll. This journey proves it in a
// real browser at the network layer: with multiple specs in the workspace,
// opening Pulse must issue the bulk (no-ref) read and NEVER the per-spec
// ?ref= fan-out.
//
// Auth/tenant: the dev fixture's personal memex (namespace `dev` / memex
// `personal`). Path-based nav. The /pulse route is reachable because
// HIDDEN_FEATURES is unset in e2e (isFeatureHidden → false).

const SPEC = "mindset-prod/memex-building-itself/specs/spec-407";

test.describe("Journey 49 — spec-407 bulk presence read (std-28)", () => {
  let nsSlug: string;
  let mxSlug: string;
  const docIds: string[] = [];

  test.beforeEach(async () => {
    const memex = await getPersonalMemexByEmail("dev@memex.ai");
    if (!memex) throw new Error("dev@memex.ai has no personal memex — fixture setup drifted");
    nsSlug = memex.namespaceSlug;
    mxSlug = memex.memexSlug;
    const devUserId = await ensureUser("dev@memex.ai");

    // Seed TWO specs so usePresence receives >1 ref and exercises the
    // whole-workspace bulk path (a single ref would use the targeted ?ref=
    // read — that's the ambient indicator, not the pathological fan-out).
    for (const title of ["Jabberwock Presence A", "Jabberwock Presence B"]) {
      const { docId } = await seedSpecInMemex({
        memexId: memex.memexId,
        title,
        purpose: `${title} — seeded for the spec-407 bulk-presence journey.`,
        createdByUserId: devUserId,
      });
      docIds.push(docId);
    }
  });

  test.afterEach(async () => {
    while (docIds.length) {
      const id = docIds.pop();
      if (id) await deleteDoc(id);
    }
  });

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status === "skipped") return;
    await emitAcEvents(
      [`${SPEC}/acs/ac-3`, `${SPEC}/acs/ac-1`],
      testInfo.status === "passed" ? "pass" : "fail",
      `packages/ui/e2e/journey-49-spec-407-bulk-presence.spec.ts::${testInfo.title}`,
      testInfo.duration ?? 0,
    );
  });

  test("ac-1/ac-3: opening Pulse 'Working now' issues the bulk presence read, never the per-spec fan-out", async ({
    page,
  }) => {
    // Collect every presence READ (GET) the page makes. The heartbeat is a POST
    // and is filtered out; we only care about the read fan-out.
    const presenceReads: string[] = [];
    page.on("request", (req: Request) => {
      if (req.method() !== "GET") return;
      if (req.url().includes("/presence")) presenceReads.push(req.url());
    });

    await page.goto(tenantPath(nsSlug, mxSlug, "/pulse"));

    // The "Working now" zone polls presence once the spec list loads.
    await page.waitForRequest(
      (req) => req.method() === "GET" && req.url().includes("/presence"),
      { timeout: 20_000 },
    );
    // Give any (erroneous) per-spec fan-out requests a chance to also fire.
    await page.waitForTimeout(1_500);

    expect(presenceReads.length).toBeGreaterThan(0);

    // The fan-out signature is a per-spec ?ref= query. After spec-407 there must
    // be NONE — the page asks once for the whole workspace.
    const fannedOut = presenceReads.filter((u) => u.includes("ref="));
    expect(fannedOut, `expected no per-spec presence fan-out, saw: ${fannedOut.join(", ")}`).toEqual(
      [],
    );

    // And at least one request IS the bulk whole-workspace read (path ends at
    // /presence with no query).
    const bulk = presenceReads.filter((u) => new URL(u).pathname.endsWith("/presence") && !u.includes("?"));
    expect(bulk.length).toBeGreaterThan(0);
  });
});
