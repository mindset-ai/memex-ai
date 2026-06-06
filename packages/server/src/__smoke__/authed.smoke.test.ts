// Post-deploy smoke — AUTHED tier (b-70 t-8 / dec-2, dec-3 authed tier).
//
// Drives a create→read→delete journey over the live `/mcp` endpoint with a
// dedicated smoke `mxt_` Bearer token, INSIDE a clearly-marked throwaway
// namespace/memex (SMOKE_NAMESPACE, default `zzz-smoke`). It MUST NEVER touch
// any real namespace/memex on the shared host (dec-2). Everything it creates is
// torn down idempotently in afterEach/afterAll — heeding the dec-6 lesson that a
// leaky suite pollutes a shared env the way leaky tests polluted local Postgres.
//
// The whole tier SKIPS CLEANLY when SMOKE_MCP_TOKEN is unset (dec-3 / dec-5
// skip-when-unconfigured), so the deploy-tail run stays green where creds are
// absent. The smoke token is provisioned by the external, PAM-gated t-9
// (Secret Manager + support@memex.ai) — until it exists, only the skip path is
// exercised. When the token IS set, SMOKE_NAMESPACE must already point at the
// provisioned throwaway namespace/memex the token is scoped to.
//
// Also folds in the de-drifted canonical-refs check (dec-1): the old
// scripts/smoke-canonical-refs.ts is authed (it hits /mcp with a token), so its
// two assertions live here in the authed tier with a per-env default ref
// (SMOKE_CANONICAL_REF) — no longer the stale pre-migration
// `mindset-int/memex-app/specs/spec-36`.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  SMOKE_BASE_URL,
  SMOKE_MCP_TOKEN,
  SMOKE_SESSION_TOKEN,
  SMOKE_NAMESPACE,
  callMcpTool,
  callMcpInitialize,
  mcpTextPayload,
} from "./smoke-env.js";

// A throwaway UUID — shape only matters; the canonical-refs guard must reject it
// at the boundary before any DB lookup.
const SMOKE_UUID = "00000000-0000-4000-8000-000000000000";
const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/** Pull the first `ref: <ref>` token out of an MCP text payload. */
function parseRef(text: string): string | null {
  // Exclude closing punctuation: tool replies often parenthesise the ref
  // ("… (ref: ns/mx/specs/spec-1/sections/s-2)."), and a captured `).` makes
  // the next tool call fail on an invalid ref.
  const m = text.match(/ref:\s*([^\s")]+)/i);
  return m ? m[1] : null;
}

// Refs we create during the journey, newest-deletable-first, swept in afterAll
// so a mid-journey failure can't leave the throwaway namespace dirty.
const createdTaskRefs: string[] = [];

async function deleteTaskQuiet(ref: string): Promise<void> {
  try {
    await callMcpTool("delete_task", { ref });
  } catch {
    // Idempotent teardown: a task already gone (or never created) is fine.
  }
}

describe.skipIf(!SMOKE_MCP_TOKEN)(
  `authed smoke @ ${SMOKE_BASE_URL} (ns=${SMOKE_NAMESPACE})`,
  () => {
    beforeAll(() => {
      // Guard rail (dec-2): refuse to run authed write journeys against anything
      // that doesn't read as a throwaway namespace, so a misconfigured token can
      // never mutate real data on shared int/prod.
      if (!/smoke/i.test(SMOKE_NAMESPACE)) {
        throw new Error(
          `Refusing to run authed smoke writes against namespace "${SMOKE_NAMESPACE}" — ` +
            `it must be an obvious throwaway (contain "smoke"). Set SMOKE_NAMESPACE.`,
        );
      }
    });

    afterAll(async () => {
      // Idempotent sweep of anything the journey created but didn't already clean.
      for (const ref of createdTaskRefs.splice(0)) {
        await deleteTaskQuiet(ref);
      }
    });

    // ── Coverage for the merged MR a7eab29 (`feat/mcp-instructions-truncation-fix`):
    //    on-demand guidance via get_information + 2KB instructions cap.
    //
    //    These probes test the DEPLOYED contract, not the source. The unit-test
    //    regression guard (instructions-truncation.regression.test.ts) enforces
    //    that MEMEX_AGENT_INSTRUCTIONS stays ≤1750 bytes in source; this smoke
    //    confirms the live HTTP-delivered string honours the same cap (a future
    //    middleware that injected extra prose would slip past the unit guard).
    //    The get_information probes catch the class of bug the build script
    //    missed: src/guidance/*.json existing in source but not landing in dist/
    //    on the deployed container (ENOENT at runtime).
    it("initialize returns server instructions within the 1750-byte Claude Code cap with load-bearing tokens", async () => {
      const { status, body } = await callMcpInitialize();
      expect(status).toBe(200);
      expect(body.error).toBeUndefined();
      const instructions = body.result?.instructions ?? "";
      expect(instructions.length).toBeGreaterThan(0);
      // Same cap as the source-side regression test — 300-byte margin under
      // Anthropic's documented 2048-byte truncation.
      expect(instructions.length).toBeLessThanOrEqual(1750);
      // Load-bearing tokens that MUST survive truncation. Subset of what the
      // unit test checks; if any of these vanish from the live response the
      // agent operates without a critical rule.
      expect(instructions).toMatch(/get_information/);
      expect(instructions).toMatch(/list_memexes/);
    });

    it("get_information() returns the topic index for all guidance/*.json files", async () => {
      const { status, body } = await callMcpTool("get_information", {});
      expect(status).toBe(200);
      expect(body.result?.isError).toBeFalsy();
      const text = mcpTextPayload(body);
      // All four starter topics from the source tree must round-trip.
      // The build script must `cp src/guidance/*.json dist/guidance/` —
      // when it doesn't, this test fails with the ENOENT envelope.
      expect(text).toMatch(/decisions-vs-tasks/);
      expect(text).toMatch(/phases/);
      expect(text).toMatch(/rule-overrides/);
      expect(text).toMatch(/stuck/);
    });

    it("get_information({topic:'phases'}) returns the body, not just the index", async () => {
      const { status, body } = await callMcpTool("get_information", {
        topic: "phases",
      });
      expect(status).toBe(200);
      expect(body.result?.isError).toBeFalsy();
      const text = mcpTextPayload(body);
      // Phase mechanics are the largest topic and the one most likely to be
      // referenced by other tools. Body should describe the 5-phase pipeline.
      expect(text).toMatch(/draft/);
      expect(text).toMatch(/specify/);
      expect(text).toMatch(/build/);
      expect(text).toMatch(/verify/);
      expect(text).toMatch(/done/);
    });

    it("canonical ref call succeeds and emits `ref:` (no UUIDs leaked)", async () => {
      // The smoke token is scoped to the throwaway tenant (zzz-smoke), so the
      // per-env default SMOKE_CANONICAL_REF (a real-tenant doc) 404s under
      // std-7. Unless a ref is explicitly provided for an ad-hoc run with a
      // wider-scoped token, provision our own doc and assert the canonical-ref
      // grammar on it — the b-36 property (refs in, no UUIDs out) is the same.
      let ref = process.env.SMOKE_CANONICAL_REF ?? "";
      if (!ref) {
        const created = await callMcpTool("create_doc", {
          memex: SMOKE_NAMESPACE,
          title: `[smoke] canonical-ref probe ${new Date().toISOString()}`,
          purpose: "Canonical-ref smoke — safe to delete.",
        });
        expect(created.body.result?.isError).toBeFalsy();
        ref = parseRef(mcpTextPayload(created.body)) ?? "";
        expect(ref, "create_doc should return a canonical ref").toBeTruthy();
      }
      const { status, body } = await callMcpTool("get_doc", { ref });
      expect(status).toBe(200);
      expect(body.error).toBeUndefined();
      expect(body.result?.isError).toBeFalsy();
      const text = mcpTextPayload(body);
      expect(text).toMatch(/\bref:/i);
      // The b-36 hard-cut: canonical refs in, no raw UUIDs out.
      expect(UUID_RE.test(text)).toBe(false);
    });

    it("UUID-shaped input is rejected with the structured migration error", async () => {
      const { body } = await callMcpTool("get_doc", { ref: SMOKE_UUID });
      const msg = body.error?.message ?? mcpTextPayload(body);
      const isError = !!body.error || body.result?.isError === true;
      expect(isError).toBe(true);
      expect(msg).toMatch(/UUID inputs no longer accepted/i);
    });

    it("AC endpoint returns a denormalised snapshot with verificationState (std-17 coverage for the AC tab)", async () => {
      // Live probe for the AC tab's underlying REST endpoint. Catches the
      // class of bug pure local tests miss (route not mounted on deployed
      // image, sessionMiddleware misconfigured for this surface, etc.).
      //
      // Two steps:
      //   1. Create a throwaway doc + AC via MCP (existing tools).
      //   2. Hit GET /api/<ns>/<mx>/acs/doc/<docId> directly with the same
      //      Bearer token, assert the snapshot shape + verification state.
      //
      // The path-based route mount is what we're testing; flat-mounted entity
      // lookups (`/api/acs/doc/<id>`) are a separate code path that the
      // smoke-token's single-membership case doesn't exercise here.
      const stamp = new Date().toISOString();
      const createdDoc = await callMcpTool("create_doc", {
        memex: SMOKE_NAMESPACE,
        title: `[smoke] AC endpoint check ${stamp}`,
        purpose: "AC endpoint smoke — safe to delete.",
      });
      expect(createdDoc.body.result?.isError).toBeFalsy();
      const docRef = parseRef(mcpTextPayload(createdDoc.body));
      expect(docRef).toBeTruthy();

      const acRes = await callMcpTool("create_ac", {
        ref: docRef!,
        kind: "scope",
        statement: "Smoke probe: AC endpoint returns the snapshot shape.",
      });
      expect(acRes.body.result?.isError).toBeFalsy();

      // Resolve the doc id by reading get_doc (its response carries a UUID
      // we can use for the REST endpoint). Faster alternative would be to
      // parse it from create_doc's response, but parsing the UUID from a
      // text payload is brittle — get_doc's verbose mode is documented.
      // Parse <ns>/<mx>/specs/<handle> from the ref so the REST URL is
      // robust regardless of what SMOKE_NAMESPACE is set to (bare namespace
      // vs <ns>/<mx> — the smoke env doesn't distinguish, but the REST
      // route mount needs both).
      const refParts = docRef!.split("/");
      expect(refParts.length).toBeGreaterThanOrEqual(4);
      const [refNs, refMx] = refParts;

      // b-36 hard-cut: MCP output never carries raw UUIDs (even verbose), so
      // resolve the docId the way the React UI does — the REST docs list,
      // which speaks UUIDs to session-authed callers. REST sits behind
      // sessionMiddleware (JWT-only), so these calls use SMOKE_SESSION_TOKEN.
      const listRes = await fetch(`${SMOKE_BASE_URL}/api/${refNs}/${refMx}/docs`, {
        headers: { Authorization: `Bearer ${SMOKE_SESSION_TOKEN}` },
      });
      expect(listRes.status).toBe(200);
      const docsList = (await listRes.json()) as Array<{ id: string; title: string }>;
      const ourDoc = docsList.find((d) => d.title === `[smoke] AC endpoint check ${stamp}`);
      expect(ourDoc, "expected the created doc in the REST docs list").toBeDefined();
      const docId = ourDoc!.id;

      const url = `${SMOKE_BASE_URL}/api/${refNs}/${refMx}/acs/doc/${docId}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${SMOKE_SESSION_TOKEN}` },
      });
      expect(res.status).toBe(200);
      const rows = (await res.json()) as Array<{
        ac: { kind: string; statement: string };
        verificationState: string;
        canonicalRef: string;
        tests: unknown[];
      }>;
      // Newly-created AC, no tagged tests in the smoke codebase — must be
      // 'untested'. If derivation logic regresses (e.g. defaults to
      // 'verified' on empty events) this assertion fails loudly.
      expect(rows.length).toBeGreaterThanOrEqual(1);
      const ours = rows.find((r) =>
        r.ac.statement.startsWith("Smoke probe:"),
      );
      expect(ours, "expected our smoke-probe AC in the response").toBeDefined();
      expect(ours!.ac.kind).toBe("scope");
      expect(ours!.verificationState).toBe("untested");
      expect(ours!.tests).toEqual([]);
      expect(ours!.canonicalRef).toMatch(/\/acs\/ac-\d+$/);

      // Sparkline endpoint — same Spec, days clamp, response shape.
      const histRes = await fetch(
        `${SMOKE_BASE_URL}/api/${refNs}/${refMx}/acs/doc/${docId}/alignment-history?days=14`,
        { headers: { Authorization: `Bearer ${SMOKE_SESSION_TOKEN}` } },
      );
      expect(histRes.status).toBe(200);
      const hist = (await histRes.json()) as Array<{
        date: string;
        kind: string;
        verified: number;
        total: number;
      }>;
      // 14 days × at most 1 kind (only scope present) — flexible upper bound
      // in case other AC kinds get added by future smoke iterations.
      expect(hist.length).toBeGreaterThanOrEqual(14);
    });

    it("create → read → delete journey self-cleans in the throwaway namespace", async () => {
      const stamp = new Date().toISOString();
      const title = `[smoke] throwaway ${stamp}`;

      // CREATE — a doc in the throwaway memex.
      const created = await callMcpTool("create_doc", {
        memex: SMOKE_NAMESPACE,
        title,
        purpose: "Post-deploy smoke journey — safe to delete.",
      });
      expect(created.status).toBe(200);
      expect(created.body.result?.isError).toBeFalsy();
      const docRef = parseRef(mcpTextPayload(created.body));
      expect(docRef, "create_doc should return a canonical ref").toBeTruthy();

      // Move to build so a task can be created (tasks are build-phase only).
      await callMcpTool("update_doc", { ref: docRef!, status: "specify" });
      await callMcpTool("update_doc", { ref: docRef!, status: "build" });

      // CREATE the deletable entity — a task on the throwaway doc.
      const taskRes = await callMcpTool("create_task", {
        ref: docRef!,
        title: "smoke throwaway task",
        description: "Created and deleted by the post-deploy smoke journey.",
      });
      expect(taskRes.body.result?.isError).toBeFalsy();
      const taskRef = parseRef(mcpTextPayload(taskRes.body));
      expect(taskRef, "create_task should return a canonical ref").toBeTruthy();
      createdTaskRefs.push(taskRef!);

      // READ — get_doc must show the doc + the task we just created.
      const readRes = await callMcpTool("get_doc", { ref: docRef! });
      expect(readRes.status).toBe(200);
      const readText = mcpTextPayload(readRes.body);
      expect(readText).toContain(title);

      // DELETE — the genuine destructive primitive; removes the task we created.
      const delRes = await callMcpTool("delete_task", { ref: taskRef! });
      expect(delRes.body.result?.isError).toBeFalsy();
      // Mark swept so afterAll doesn't try again.
      createdTaskRefs.splice(createdTaskRefs.indexOf(taskRef!), 1);

      // VERIFY the delete landed — the task ref no longer resolves.
      const verify = await callMcpTool("get_doc", { ref: taskRef! });
      const verifyIsError =
        !!verify.body.error || verify.body.result?.isError === true;
      expect(verifyIsError).toBe(true);
    });

    // ── Coverage for spec-107 (MCP section management): retitle_section +
    //    delete_section. The merged work was deployed to int with NO smoke
    //    probe; this drives the live create→add→retitle→delete section
    //    lifecycle over /mcp so a future regression in the deployed tools (or
    //    the soft-delete read-path filtering) fails loudly here. A unique
    //    marker in the section body lets us assert the section is present
    //    after add, that its CONTENT survives a retitle (heading-only change),
    //    and that it disappears from get_doc after the soft delete.
    it("section lifecycle: add_section → retitle_section → delete_section over /mcp (spec-107)", async () => {
      const stamp = new Date().toISOString();
      const marker = `smoke-section-${stamp}`;

      // CREATE a throwaway doc to hang a section off.
      const created = await callMcpTool("create_doc", {
        memex: SMOKE_NAMESPACE,
        title: `[smoke] section lifecycle ${stamp}`,
        purpose: "Section-tool smoke (spec-107) — safe to delete.",
      });
      expect(created.body.result?.isError).toBeFalsy();
      const docRef = parseRef(mcpTextPayload(created.body));
      expect(docRef, "create_doc should return a canonical ref").toBeTruthy();

      // ADD a section carrying a unique marker we can assert on/off.
      const added = await callMcpTool("add_section", {
        ref: docRef!,
        sectionType: "smoke-lens",
        title: "Smoke Lens",
        content: `Body ${marker}.`,
      });
      expect(added.body.result?.isError).toBeFalsy();
      const sectionRef = parseRef(mcpTextPayload(added.body));
      expect(sectionRef, "add_section should return a section ref").toBeTruthy();

      // READ — heading + marker are present. Terse get_doc omits section
      // bodies, so these lifecycle reads use verbose mode.
      let docText = mcpTextPayload(
        (await callMcpTool("get_doc", { ref: docRef!, verbose: true })).body,
      );
      expect(docText).toContain("Smoke Lens");
      expect(docText).toContain(marker);

      // RETITLE — heading changes; content (marker) must be untouched.
      const retitled = await callMcpTool("retitle_section", {
        ref: sectionRef!,
        title: "Smoke Lens Renamed",
      });
      expect(retitled.body.result?.isError).toBeFalsy();
      docText = mcpTextPayload(
        (await callMcpTool("get_doc", { ref: docRef!, verbose: true })).body,
      );
      expect(docText).toContain("Smoke Lens Renamed");
      expect(docText).toContain(marker);

      // DELETE (soft) — the section must drop out of get_doc entirely
      // (exercises the read-path filtering on the deployed image).
      const deleted = await callMcpTool("delete_section", { ref: sectionRef! });
      expect(deleted.body.result?.isError).toBeFalsy();
      docText = mcpTextPayload(
        (await callMcpTool("get_doc", { ref: docRef!, verbose: true })).body,
      );
      expect(docText).not.toContain(marker);
      expect(docText).not.toContain("Smoke Lens Renamed");
    });

    // ── spec-189: traffic-driven phase advancement on the LIVE /mcp surface.
    //
    //    Specify-class traffic (create_decision) at a freshly-created draft
    //    Spec must auto-advance it draft → specify; build-class traffic
    //    (create_task) must then advance it specify → build. This is the
    //    deployed-contract probe for the runToolWithSpecTraffic seam — the
    //    exact class of /mcp wiring that std-17's first live run proved local
    //    suites can miss. The full matrix is locked by unit + integration
    //    tests; the smoke probe asserts the seam is ALIVE on the deployed
    //    image, not the matrix itself.
    it("spec-189: agent traffic auto-advances a draft Spec (draft → specify → build)", async () => {
      const created = await callMcpTool("create_doc", {
        memex: SMOKE_NAMESPACE,
        title: `[smoke] spec-189 traffic probe ${new Date().toISOString()}`,
        purpose: "Throwaway probe — traffic-driven phase advancement.",
      });
      expect(created.status).toBe(200);
      expect(created.body.result?.isError).toBeFalsy();
      const specRef = parseRef(mcpTextPayload(created.body));
      expect(specRef, "create_doc should return a spec ref").toBeTruthy();

      // Specify-class traffic: decision authoring.
      const dec = await callMcpTool("create_decision", {
        ref: specRef!,
        title: "[smoke] spec-189 probe decision",
      });
      expect(dec.status).toBe(200);
      expect(dec.body.result?.isError).toBeFalsy();

      let docText = mcpTextPayload(
        (await callMcpTool("get_doc", { ref: specRef! })).body,
      );
      expect(docText).toMatch(/status:\s*specify|\[SPECIFY\]|phase:\s*specify/i);

      // Build-class traffic: task creation (also sweeps via createdTaskRefs).
      const task = await callMcpTool("create_task", {
        ref: specRef!,
        title: "[smoke] spec-189 probe task",
        description: "Throwaway — drives specify → build.",
      });
      expect(task.status).toBe(200);
      expect(task.body.result?.isError).toBeFalsy();
      const taskRef = parseRef(mcpTextPayload(task.body));
      if (taskRef) createdTaskRefs.push(taskRef);

      docText = mcpTextPayload(
        (await callMcpTool("get_doc", { ref: specRef! })).body,
      );
      expect(docText).toMatch(/status:\s*build|\[BUILD\]|phase:\s*build/i);
    });
  },
);
