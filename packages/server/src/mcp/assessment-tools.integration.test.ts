// Integration tests for the doc-12 t-14 assessment MCP tools:
// `assess_phase_transition`, `assess_narrative_freshness`,
// `mark_narrative_consolidated`, `assess_comments_status`.
//
// Each tool wraps a service helper (phase-assessment / narrative /
// comment-assessment) and threads through the same Memex membership +
// docType=spec validation as the rest of the Spec MCP surface. We use
// the same `_registeredTools` introspection trick used in
// spec-tools.integration.test.ts.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  memexes,
  namespaces,
  orgs,
  orgMemberships,
  orgScaffoldAdditions,
  documents,
  decisions,
  tasks,
  users,
} from "../db/schema.js";
import { createMcpServer } from "./tools.js";
import { createDocDraft } from "../services/documents.js";
import { _clearRecentAssessments } from "../services/phase-assessment.js";
import {
  createOrgScaffoldAddition,
  listOrgScaffoldAdditions,
} from "../services/scaffold-additions.js";
import {
  _resetScaffoldAdditionsCache,
  _stopScaffoldAdditionsCacheInvalidation,
  startScaffoldAdditionsCacheInvalidation,
} from "../services/scaffold-additions-cache.js";
import { BASE_SCAFFOLD, type Transition } from "@memex/shared";

const created = {
  users: [] as string[],
  memexes: [] as string[],
  docs: [] as string[],
};

// b-68 t-5: org_scaffold_additions seeded by composed-rubric tests. Cleared
// in afterAll so successive runs don't accumulate test fixtures in the org.
const createdScaffoldAdditions: string[] = [];

afterAll(async () => {
  // Detach the bus subscriber we armed in beforeAll. Production registers
  // it once for the process lifetime; the integration test owns its own
  // lifecycle.
  _stopScaffoldAdditionsCacheInvalidation();
  _resetScaffoldAdditionsCache();
  if (createdScaffoldAdditions.length) {
    await db
      .delete(orgScaffoldAdditions)
      .where(inArray(orgScaffoldAdditions.id, createdScaffoldAdditions))
      .catch(() => {});
  }
  if (created.docs.length) {
    await db.delete(tasks).where(inArray(tasks.docId, created.docs)).catch(() => {});
    await db.delete(decisions).where(inArray(decisions.docId, created.docs)).catch(() => {});
    await db.delete(documents).where(inArray(documents.id, created.docs)).catch(() => {});
  }
  if (created.memexes.length) {
    await db.delete(memexes).where(inArray(memexes.id, created.memexes)).catch(() => {});
  }
  if (created.users.length) {
    await db.delete(users).where(inArray(users.id, created.users)).catch(() => {});
  }
});

async function setupActor(prefix: string) {
  const sub = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
  const [u] = await db
    .insert(users)
    .values({ email: `mcp-assess-${sub}@memex.ai` } as any)
    .returning();
  created.users.push(u.id);
  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `Test ${sub}` }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [a] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: `Test ${sub}` }).returning();
  created.memexes.push(a.id);
  await db.insert(orgMemberships).values({ userId: u.id, orgId: org.id, role: "administrator" });
  // b-68 t-5: tests around composed rubric need the orgId to seed
  // `org_scaffold_additions` rows for ac-33 / ac-34. Personal-memex behaviour
  // is covered separately by toRubric's pure-projection tests.
  return { user: u, account: a, nsSlug: ns.slug, orgId: org.id };
}

// b-36 T-6: build a canonical ref for a doc within the actor's memex.
function refFor(actor: { nsSlug: string }, doc: { docType: string; handle: string }): string {
  const docTypeUrl =
    doc.docType === "spec"
      ? "specs"
      : doc.docType === "standard"
        ? "standards"
        : doc.docType === "execution_plan"
          ? "execution-plans"
          : "docs";
  return `${actor.nsSlug}/main/${docTypeUrl}/${doc.handle}`;
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}

interface RegisteredToolLike {
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult> | ToolResult;
}

async function callTool(
  userId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const server = createMcpServer(userId);
  const registry = (
    server as unknown as { _registeredTools: Record<string, RegisteredToolLike> }
  )._registeredTools;
  const tool = registry[name];
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return await tool.handler(args, {} as unknown);
}

let actor: Awaited<ReturnType<typeof setupActor>>;

beforeAll(async () => {
  actor = await setupActor("assess");
  _clearRecentAssessments();
  // Arm the std-8 bus subscriber that invalidates the per-org scaffold
  // cache. Production wires this in `index.ts`; the integration test boots
  // tools directly so it has to arm the subscriber itself, otherwise the
  // first `assess_brief` call for the actor's org primes a stale (empty)
  // cache entry that survives the 30s TTL and shadows org_scaffold_additions
  // rows created later in the suite — the ac-34 ordering test depends on
  // those rows being visible.
  startScaffoldAdditionsCacheInvalidation();
  _resetScaffoldAdditionsCache();
});

describe("Assessment MCP tools (post-doc-14)", () => {
  it("registers the consolidated assess_spec tool", () => {
    const server = createMcpServer(actor.user.id);
    const names = Object.keys(
      (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    );
    // Post doc-14 the four assess_* tools collapse into a single mode-driven tool.
    expect(names).toContain("assess_spec");
  });

  it("does NOT register pause/resume/archive Spec tools (out of scope)", () => {
    const server = createMcpServer(actor.user.id);
    const names = Object.keys(
      (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    );
    expect(names).not.toContain("pause_mission");
    expect(names).not.toContain("resume_mission");
    expect(names).not.toContain("archive_mission");
  });

  // ── assess_spec(mode='phase') ────────────────────────
  describe("assess_phase_transition (via assess_spec mode='phase')", () => {
    it("returns the rubric + fact sheet for a Spec", async () => {
      const m = await createDocDraft(actor.account.id, "PhaseM", "P", "spec");
      created.docs.push(m.id);
      const result = await callTool(actor.user.id, "assess_spec", {
        ref: refFor(actor, m),
        mode: "phase",
        target: "build",
      });
      expect(result.isError).toBeFalsy();
      const text = result.content[0].text;
      expect(text).toContain("Readiness assessment");
      expect(text).toContain("Spec facts");
      // The build rubric is keyed at the service layer; surface should mention
      // open decisions / incomplete work as standard fact-sheet keys.
      expect(text).toContain("Open decisions");
      expect(text).toContain("Incomplete tasks");
    });

    it("refuses non-Spec docs", async () => {
      const spec = await createDocDraft(actor.account.id, "SpecNoAssess", "P", "document");
      created.docs.push(spec.id);
      const result = await callTool(actor.user.id, "assess_spec", {
        ref: refFor(actor, spec),
        mode: "phase",
        target: "build",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not a Spec/i);
    });

    it("returns NotFound for an unknown ref", async () => {
      const result = await callTool(actor.user.id, "assess_spec", {
        ref: `${actor.nsSlug}/main/specs/spec-99999`,
        mode: "phase",
        target: "build",
      });
      expect(result.isError).toBe(true);
    });

    // ── doc-27 t-3: code-grounding self-classification at plan→build ─────
    describe("codeGrounding (doc-27 t-3)", () => {
      it("renders the ## Code grounding prompt when codeGrounding is undefined and target='build'", async () => {
        const m = await createDocDraft(actor.account.id, "CGPrompt", "P", "spec");
        created.docs.push(m.id);
        const result = await callTool(actor.user.id, "assess_spec", {
          ref: refFor(actor, m),
          mode: "phase",
          target: "build",
        });
        expect(result.isError).toBeFalsy();
        const text = result.content[0].text;
        expect(text).toContain("## Code grounding");
        expect(text).toContain(
          "Is this Spec's scope code-touching (does any resolved decision name code shape — files, symbols, schema, routes)?",
        );
        expect(text).toContain(
          "Call assess_spec again with `codeGrounding` set to one of: `not_applicable`, `verified`, or `not_verified`.",
        );
      });

      it("emits the 'not_applicable' nudge when codeGrounding='not_applicable'", async () => {
        const m = await createDocDraft(actor.account.id, "CGNotApplicable", "P", "spec");
        created.docs.push(m.id);
        const result = await callTool(actor.user.id, "assess_spec", {
          ref: refFor(actor, m),
          mode: "phase",
          target: "build",
          codeGrounding: "not_applicable",
        });
        expect(result.isError).toBeFalsy();
        const text = result.content[0].text;
        expect(text).toContain("Spec classified as not code-touching; no grounding check applied.");
        // The prompt section is suppressed once the agent has answered.
        expect(text).not.toContain("## Code grounding");
      });

      it("emits the 'verified' nudge when codeGrounding='verified'", async () => {
        const m = await createDocDraft(actor.account.id, "CGVerified", "P", "spec");
        created.docs.push(m.id);
        const result = await callTool(actor.user.id, "assess_spec", {
          ref: refFor(actor, m),
          mode: "phase",
          target: "build",
          codeGrounding: "verified",
        });
        expect(result.isError).toBeFalsy();
        const text = result.content[0].text;
        expect(text).toContain("Code-grounding affirmed by agent.");
        expect(text).not.toContain("## Code grounding");
      });

      it("emits the ⚠ flagged nudge when codeGrounding='not_verified'", async () => {
        const m = await createDocDraft(actor.account.id, "CGNotVerified", "P", "spec");
        created.docs.push(m.id);
        const result = await callTool(actor.user.id, "assess_spec", {
          ref: refFor(actor, m),
          mode: "phase",
          target: "build",
          codeGrounding: "not_verified",
        });
        expect(result.isError).toBeFalsy();
        const text = result.content[0].text;
        expect(text).toContain(
          "⚠ No code-grounding on this Spec. If you're driving from a coding agent, walk the resolved decisions against current source before transitioning. Build transition is not blocked.",
        );
        expect(text).not.toContain("## Code grounding");
      });

      it("update_doc({status:'build'}) succeeds even when codeGrounding='not_verified' (build transition is never blocked)", async () => {
        const m = await createDocDraft(actor.account.id, "CGNeverBlocks", "P", "spec");
        created.docs.push(m.id);
        // Move from draft → plan first so plan → build is a legal forward move.
        const planResult = await callTool(actor.user.id, "update_doc", {
          ref: refFor(actor, m),
          status: "plan",
        });
        expect(planResult.isError).toBeFalsy();

        const assess = await callTool(actor.user.id, "assess_spec", {
          ref: refFor(actor, m),
          mode: "phase",
          target: "build",
          codeGrounding: "not_verified",
        });
        expect(assess.isError).toBeFalsy();

        const buildResult = await callTool(actor.user.id, "update_doc", {
          ref: refFor(actor, m),
          status: "build",
        });
        expect(buildResult.isError).toBeFalsy();
        const fresh = await db.query.documents.findFirst({ where: eq(documents.id, m.id) });
        expect(fresh!.status).toBe("build");
      });

      it("IGNORES codeGrounding when target='plan' (no prompt, no nudge)", async () => {
        const m = await createDocDraft(actor.account.id, "CGPlanIgnored", "P", "spec");
        created.docs.push(m.id);
        const result = await callTool(actor.user.id, "assess_spec", {
          ref: refFor(actor, m),
          mode: "phase",
          target: "plan",
          codeGrounding: "verified",
        });
        expect(result.isError).toBeFalsy();
        const text = result.content[0].text;
        expect(text).not.toContain("## Code grounding");
        expect(text).not.toContain("Code-grounding affirmed by agent.");
        expect(text).not.toContain("Spec classified as not code-touching");
        expect(text).not.toContain("⚠ No code-grounding");
      });

      it("IGNORES codeGrounding when target='verify' (no prompt, no nudge)", async () => {
        const m = await createDocDraft(actor.account.id, "CGVerifyIgnored", "P", "spec");
        created.docs.push(m.id);
        const result = await callTool(actor.user.id, "assess_spec", {
          ref: refFor(actor, m),
          mode: "phase",
          target: "verify",
          codeGrounding: "verified",
        });
        expect(result.isError).toBeFalsy();
        const text = result.content[0].text;
        expect(text).not.toContain("## Code grounding");
        expect(text).not.toContain("Code-grounding affirmed by agent.");
      });

      it("IGNORES codeGrounding when target='done' (no prompt, no nudge)", async () => {
        const m = await createDocDraft(actor.account.id, "CGDoneIgnored", "P", "spec");
        created.docs.push(m.id);
        const result = await callTool(actor.user.id, "assess_spec", {
          ref: refFor(actor, m),
          mode: "phase",
          target: "done",
          codeGrounding: "verified",
        });
        expect(result.isError).toBeFalsy();
        const text = result.content[0].text;
        expect(text).not.toContain("## Code grounding");
        expect(text).not.toContain("Code-grounding affirmed by agent.");
      });
    });
  });

  // ── assess_spec(mode='narrative') ────────────────────
  describe("assess_narrative_freshness (via assess_spec mode='narrative')", () => {
    it("returns a fact sheet for a Spec", async () => {
      const m = await createDocDraft(actor.account.id, "NarrM", "P", "spec");
      created.docs.push(m.id);
      const result = await callTool(actor.user.id, "assess_spec", {
        ref: refFor(actor, m),
        mode: "narrative",
      });
      expect(result.isError).toBeFalsy();
      // Fact sheet shape from services/narrative.ts — should mention
      // "consolidated" or similar; we just assert non-empty.
      expect(result.content[0].text.length).toBeGreaterThan(0);
    });

    it("refuses non-Spec docs", async () => {
      const spec = await createDocDraft(actor.account.id, "SpecNoNarr", "P", "document");
      created.docs.push(spec.id);
      const result = await callTool(actor.user.id, "assess_spec", {
        ref: refFor(actor, spec),
        mode: "narrative",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not a Spec/i);
    });
  });

  // ── assess_spec(mode='consolidate') ──────────────────
  describe("mark_narrative_consolidated (via assess_spec mode='consolidate')", () => {
    it("stamps narrativeLastConsolidatedAt and returns confirmation", async () => {
      const m = await createDocDraft(actor.account.id, "MarkM", "P", "spec");
      created.docs.push(m.id);
      const before = await db.query.documents.findFirst({ where: eq(documents.id, m.id) });
      expect(before!.narrativeLastConsolidatedAt).toBeNull();

      const result = await callTool(actor.user.id, "assess_spec", {
        ref: refFor(actor, m),
        mode: "consolidate",
      });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toMatch(/Narrative consolidated/);

      const after = await db.query.documents.findFirst({ where: eq(documents.id, m.id) });
      expect(after!.narrativeLastConsolidatedAt).not.toBeNull();
    });

    it("refuses non-Spec docs", async () => {
      const spec = await createDocDraft(actor.account.id, "SpecNoMark", "P", "document");
      created.docs.push(spec.id);
      const result = await callTool(actor.user.id, "assess_spec", {
        ref: refFor(actor, spec),
        mode: "consolidate",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not a Spec/i);
    });
  });

  // ── assess_spec(mode='comments') ─────────────────────
  describe("assess_comments_status (via assess_spec mode='comments')", () => {
    it("returns the comments fact sheet for a Spec", async () => {
      const m = await createDocDraft(actor.account.id, "CommM", "P", "spec");
      created.docs.push(m.id);
      const result = await callTool(actor.user.id, "assess_spec", {
        ref: refFor(actor, m),
        mode: "comments",
      });
      expect(result.isError).toBeFalsy();
      const text = result.content[0].text;
      expect(text).toContain("Spec");
      expect(text).toContain("open comment");
      expect(text).toContain("Breakdown:");
    });

    it("refuses non-Spec docs", async () => {
      const spec = await createDocDraft(actor.account.id, "SpecNoComm", "P", "document");
      created.docs.push(spec.id);
      const result = await callTool(actor.user.id, "assess_spec", {
        ref: refFor(actor, spec),
        mode: "comments",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not a Spec/i);
    });
  });

  // ──────────────────────────────────────────────────────────────────────
  // b-68 t-5: composed rubric prose (toRubric) wired into assess_brief.
  //
  // The response must surface the base TransitionRubric prose for every
  // forward target (ac-34) AND any enabled `{transition}`-targeted Org
  // blocks AFTER the base text in `order` (ac-34). Critically the prose
  // sits AFTER the deterministic fact sheet behind a clear heading
  // boundary (ac-35) — the two channels are never interleaved.
  //
  // ac-33 verifies the round-trip through the t-3 service: a `{transition}`
  // -targeted Org block written via createOrgScaffoldAddition is read back
  // through listOrgScaffoldAdditions with its target.transition intact.
  // ──────────────────────────────────────────────────────────────────────
  describe("b-68 t-5: composed rubric prose (toRubric)", () => {
    const FORWARD_TRANSITIONS: readonly Transition[] = [
      "plan",
      "build",
      "verify",
      "done",
    ];

    function baseRubricText(transition: Transition): string {
      const rubric = BASE_SCAFFOLD.transitions.find((t) => t.transition === transition);
      if (!rubric) throw new Error(`No base TransitionRubric for ${transition}`);
      return rubric.text;
    }

    // Pick a distinctive sentence from each base TransitionRubric so the
    // assertion is robust to surrounding whitespace and section ordering.
    // Picking the H1 ("# <transition>-readiness review") keeps the matcher
    // stable across rubric prose edits unless the heading itself changes.
    function baseRubricSignature(transition: Transition): string {
      const text = baseRubricText(transition);
      const firstLine = text.split("\n")[0];
      return firstLine;
    }

    it("ac-34: every forward transition surfaces the base TransitionRubric text in the response", async () => {
      tagAc("mindset-prod/memex-building-itself/specs/spec-68/acs/ac-34");

      for (const target of FORWARD_TRANSITIONS) {
        const m = await createDocDraft(actor.account.id, `RubricBase-${target}`, "P", "spec");
        created.docs.push(m.id);
        const result = await callTool(actor.user.id, "assess_spec", {
          ref: refFor(actor, m),
          mode: "phase",
          target,
          // Suppress the code-grounding prompt on the build target so the
          // ## Code grounding section doesn't fight for space with the
          // rubric-prose section — orthogonal flows.
          ...(target === "build" ? { codeGrounding: "not_applicable" } : {}),
        });
        expect(result.isError).toBeFalsy();
        const text = result.content[0].text;
        // The composed prose is rendered under the `## Rubric prose`
        // heading and includes the base TransitionRubric text verbatim.
        expect(text).toContain("## Rubric prose");
        expect(text).toContain(baseRubricSignature(target));
      }
    });

    it("ac-34: enabled Org `{transition}`-targeted blocks appear AFTER the base rubric, in `order`", async () => {
      tagAc("mindset-prod/memex-building-itself/specs/spec-68/acs/ac-34");

      const target: Transition = "build";

      // Two enabled Org blocks with deliberately reversed insertion order
      // vs. `order` — this proves the projection sorts on `order`, not on
      // insertion or createdAt.
      const blockB = await createOrgScaffoldAddition({
        orgId: actor.orgId,
        authorId: actor.user.id,
        target: { transition: target },
        text: "ORG-RUBRIC-BLOCK-B: appears second by order.",
        rationale: "test-fixture: second org block for ac-34 ordering proof.",
        enabled: true,
        order: 20,
      });
      createdScaffoldAdditions.push(blockB.id);

      const blockA = await createOrgScaffoldAddition({
        orgId: actor.orgId,
        authorId: actor.user.id,
        target: { transition: target },
        text: "ORG-RUBRIC-BLOCK-A: appears first by order.",
        rationale: "test-fixture: first org block for ac-34 ordering proof.",
        enabled: true,
        order: 10,
      });
      createdScaffoldAdditions.push(blockA.id);

      // Disabled block — must NOT appear in the composed output.
      const blockDisabled = await createOrgScaffoldAddition({
        orgId: actor.orgId,
        authorId: actor.user.id,
        target: { transition: target },
        text: "ORG-RUBRIC-BLOCK-DISABLED: must never appear.",
        rationale: "test-fixture: disabled block must be filtered out.",
        enabled: false,
        order: 5,
      });
      createdScaffoldAdditions.push(blockDisabled.id);

      const m = await createDocDraft(actor.account.id, "RubricOrgOrder", "P", "spec");
      created.docs.push(m.id);
      const result = await callTool(actor.user.id, "assess_spec", {
        ref: refFor(actor, m),
        mode: "phase",
        target,
        codeGrounding: "not_applicable",
      });
      expect(result.isError).toBeFalsy();
      const text = result.content[0].text;

      const baseSig = baseRubricSignature(target);
      const baseIdx = text.indexOf(baseSig);
      const aIdx = text.indexOf("ORG-RUBRIC-BLOCK-A");
      const bIdx = text.indexOf("ORG-RUBRIC-BLOCK-B");
      expect(baseIdx, "base rubric must be present").toBeGreaterThan(-1);
      expect(aIdx, "ORG-RUBRIC-BLOCK-A must be present").toBeGreaterThan(-1);
      expect(bIdx, "ORG-RUBRIC-BLOCK-B must be present").toBeGreaterThan(-1);
      expect(aIdx, "Org block A must appear after the base rubric").toBeGreaterThan(baseIdx);
      expect(bIdx, "Org block B must appear after block A (lower `order`)").toBeGreaterThan(aIdx);
      // Disabled block must not leak through.
      expect(text).not.toContain("ORG-RUBRIC-BLOCK-DISABLED");
    });

    it("ac-35: the response separates the fact sheet from the rubric prose with a clear heading boundary", async () => {
      tagAc("mindset-prod/memex-building-itself/specs/spec-68/acs/ac-35");

      const m = await createDocDraft(actor.account.id, "RubricSeparation", "P", "spec");
      created.docs.push(m.id);
      const result = await callTool(actor.user.id, "assess_spec", {
        ref: refFor(actor, m),
        mode: "phase",
        target: "build",
        codeGrounding: "not_applicable",
      });
      expect(result.isError).toBeFalsy();
      const text = result.content[0].text;

      const factsIdx = text.indexOf("## Spec facts");
      const proseIdx = text.indexOf("## Rubric prose");
      expect(factsIdx, "the deterministic ## Spec facts heading is required").toBeGreaterThan(-1);
      expect(proseIdx, "the ## Rubric prose heading is required").toBeGreaterThan(-1);
      expect(
        proseIdx,
        "the rubric prose must appear AFTER the deterministic fact sheet",
      ).toBeGreaterThan(factsIdx);

      // The deterministic fact sheet body lives between the two headings.
      // Pull that slice and assert the rubric-prose markers do NOT bleed in
      // — that's the "never interleaved" contract.
      const factSheetSection = text.slice(factsIdx, proseIdx);
      // The base build rubric leads with `# Plan-to-build readiness review`;
      // it must not appear inside the fact-sheet slice.
      expect(factSheetSection).not.toContain("Plan-to-build readiness review");
      expect(factSheetSection).not.toContain("## Rubric prose");

      // A horizontal-rule boundary between the deterministic block and the
      // prose block keeps the visual separation unambiguous for human
      // readers walking the response.
      expect(text).toMatch(/\n---\n##\s+Rubric prose/);
    });

    it("ac-33: `{transition}`-targeted Org blocks round-trip cleanly through createOrgScaffoldAddition + listOrgScaffoldAdditions", async () => {
      tagAc("mindset-prod/memex-building-itself/specs/spec-68/acs/ac-33");

      const target: Transition = "verify";
      const roundTripBlock = await createOrgScaffoldAddition({
        orgId: actor.orgId,
        authorId: actor.user.id,
        target: { transition: target },
        text: "Round-trip test: ensure target.transition persists through the service layer.",
        rationale: "test-fixture: ac-33 round-trip assertion.",
        enabled: true,
        order: 99,
      });
      createdScaffoldAdditions.push(roundTripBlock.id);

      const all = await listOrgScaffoldAdditions(actor.orgId, { enabledOnly: true });
      const round = all.find((b) => b.id === roundTripBlock.id);
      expect(round, "round-tripped block must be retrievable via list").toBeDefined();
      expect(round!.target.transition).toBe(target);
      expect(round!.target.phase).toBeUndefined();
      expect(round!.target.tool).toBeUndefined();
      expect(round!.source).toBe("org");
      expect(round!.enabled).toBe(true);
      expect(round!.order).toBe(99);
    });
  });
});
