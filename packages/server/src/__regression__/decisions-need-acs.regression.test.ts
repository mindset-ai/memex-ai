// Regression guard: the "every resolved decision needs ≥1 implementation AC"
// discipline must keep FIRING, not merely keep being mentioned.
//
// spec-392 (workstream C of spec-388): this guard used to be SOURCE-TEXT only —
// it greped tool-specs/handler/phase-assessment source for the nudge prose and
// the shared helper's three filter clauses. "The string exists" is a weak proxy
// for "the nudge actually fires" and "the naked-decision filter actually works".
// The high-value channels are now BEHAVIOURAL: they call the runtime producers
// directly so a future trim that breaks the behaviour fails here, not silently.
//
// Five surfaces, each carrying its own piece of the discipline:
//   Channel A — JIT nudge on resolve_decision  → renderFooterSignal({kind:'decision_resolved'}) (BEHAVIOURAL)
//   Channel B — Guidance topic body             → guidance/decisions-need-acs.json (static — prose is the artifact)
//   Channel C — list_acs header + tail nudge    → source wiring (the helper import + header shape)
//   Channel D — assess_spec build rubric        → BASE_SCAFFOLD rubric (static); the live nudge is Channel A's producer
//   Channel E — shared helper computation       → listResolvedDecisionImplAcCoverage (BEHAVIOURAL, DB-backed)
//
// Channels B and D stay source/projection assertions because the artifact under
// guard IS prose (a guidance JSON body, a scaffold rubric string) — there is no
// runtime "behaviour" to exercise beyond the text itself. Channels A and E are
// converted to exercise the real path.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { BASE_SCAFFOLD } from "@memex/shared";
import { renderFooterSignal } from "../agent/handlers/tool-contract.js";
import { db } from "../db/connection.js";
import { documents, acs, decisions } from "../db/schema.js";
import { createDocDraft } from "../services/documents.js";
import { createDecision, resolveDecision } from "../services/decisions.js";
import { createAc, listResolvedDecisionImplAcCoverage } from "../services/acs.js";
import { makeTestMemex } from "../services/test-helpers.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-392/acs/ac-${n}`;

const SERVER_ROOT = join(__dirname, "..", "..");
const TOOL_SPECS = join(SERVER_ROOT, "src", "agent", "tool-specs.ts");
const HANDLERS_DIR = join(SERVER_ROOT, "src", "agent", "handlers");
const GUIDANCE = join(SERVER_ROOT, "src", "guidance", "decisions-need-acs.json");

const toolSpecs = [
  readFileSync(TOOL_SPECS, "utf-8"),
  ...readdirSync(HANDLERS_DIR)
    .filter((n) => n.endsWith(".ts"))
    .map((n) => readFileSync(join(HANDLERS_DIR, n), "utf-8")),
].join("\n");

const rubric =
  BASE_SCAFFOLD.transitions.find((t) => t.transition === "build")?.text ?? "";

// ───────────────────────────────────────────────────────────────────────────
// Channel A (BEHAVIOURAL, spec-392 ac-4) — the resolve_decision JIT nudge is
// produced at runtime by renderFooterSignal. With no linked ACs (linkedAcs:[])
// the producer takes the fallback branch — the nudge that tells the agent to
// author implementation ACs. We call the REAL producer and assert the nudge
// fires, instead of greping handler source for the literal clause.
// ───────────────────────────────────────────────────────────────────────────
describe("Channel A — resolve_decision JIT nudge (behavioural: renderFooterSignal fires)", () => {
  const decRef =
    "mindset-prod/memex-building-itself/specs/spec-392/decisions/dec-9";

  async function renderResolvedNudge(): Promise<string> {
    const out = await renderFooterSignal(
      { kind: "decision_resolved", decRef, linkedAcs: [], issueHits: [] },
      // memexId / docId are unused by the decision_resolved fallback branch.
      "00000000-0000-0000-0000-000000000000",
      "00000000-0000-0000-0000-000000000000",
    );
    return out ?? "";
  }

  it("nudges the agent to create the implementation acceptance criteria", async () => {
    tagAc(AC(4));
    const nudge = await renderResolvedNudge();
    expect(nudge).toMatch(/create the implementation acceptance criteria/i);
  });

  it("shows the create_ac syntax with parent_decision_ref pre-filled to the dec ref", async () => {
    tagAc(AC(4));
    const nudge = await renderResolvedNudge();
    expect(nudge).toMatch(
      /create_ac\(\{[^}]*kind:\s*'implementation'[^}]*parent_decision_ref:/,
    );
    // The nudge threads the ACTUAL decision ref it was called with — proof it's
    // the runtime producer, not a static template a grep would also match.
    expect(nudge).toContain(decRef);
  });

  it("cites the decisions-need-acs guidance topic", async () => {
    tagAc(AC(4));
    const nudge = await renderResolvedNudge();
    expect(nudge).toMatch(/get_information\(topic='decisions-need-acs'\)/);
  });

  it("warns the spec can't move into build until the decision has implementation ACs", async () => {
    tagAc(AC(4));
    const nudge = await renderResolvedNudge();
    expect(nudge).toMatch(/can't move into build/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Channel B — guidance topic body (static: the artifact under guard is prose).
// ───────────────────────────────────────────────────────────────────────────
describe("Channel B — guidance topic body", () => {
  const topic = JSON.parse(readFileSync(GUIDANCE, "utf-8")) as {
    title: string;
    when_to_read: string;
    body: string;
  };

  it("title frames the rule as 'commitment without a verification path'", () => {
    expect(topic.title).toMatch(/commitment without a verification path/i);
  });

  it("when_to_read points at the resolve_decision moment", () => {
    expect(topic.when_to_read).toMatch(/resolve_decision/);
    expect(topic.when_to_read).toMatch(/assess_spec/);
  });

  it("body names the rule explicitly", () => {
    expect(topic.body).toMatch(
      /every resolved decision must have at least one child implementation AC/i,
    );
  });

  it("body cites the build-readiness gate", () => {
    expect(topic.body).toMatch(/specify→build/);
    expect(topic.body).toMatch(/hold/);
  });

  it("body explains the asymmetry the rule fixes (scope-only nudge → both)", () => {
    expect(topic.body).toMatch(/scope/i);
    expect(topic.body).toMatch(/implementation/i);
    expect(topic.body).toMatch(/asymmetry/i);
  });

  it("body pairs with decisions-vs-tasks and test-coverage", () => {
    expect(topic.body).toMatch(/decisions-vs-tasks/);
    expect(topic.body).toMatch(/test-coverage/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Channel C — list_acs surfaces the naked-decisions gap. The header rendering
// + tail nudge live in handler source; the wiring (the helper is imported and
// the NAKED line is rendered) is a source assertion, but the COMPUTATION it
// renders is now behaviourally proven by Channel E below.
// ───────────────────────────────────────────────────────────────────────────
describe("Channel C — list_acs surfaces the naked-decisions gap (wiring)", () => {
  it("imports listResolvedDecisionImplAcCoverage from the service", () => {
    expect(toolSpecs).toMatch(/listResolvedDecisionImplAcCoverage/);
  });

  it("renders a 'resolved decision · with implementation ACs' line in the header", () => {
    expect(toolSpecs).toMatch(/resolved decision/);
    expect(toolSpecs).toMatch(/with implementation ACs/);
  });

  it("surfaces NAKED decision handles on the header when any are missing ACs", () => {
    expect(toolSpecs).toMatch(/NAKED:/);
  });

  it("tail nudge points at the decisions-need-acs guidance topic", () => {
    expect(toolSpecs).toMatch(/get_information\(topic='decisions-need-acs'\)/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Channel D — assess_spec build rubric (static: the rubric is scaffold prose).
// The LIVE build-target nudge is the runtime half and is exercised by Channel A
// above (the same renderFooterSignal producer); here we pin the rubric text
// that lives as a projection on BASE_SCAFFOLD.transitions.
// ───────────────────────────────────────────────────────────────────────────
describe("Channel D — assess_spec build rubric names the impl-AC check", () => {
  it("rubric names the implementation-AC-per-resolved-decision check as a hold trigger", () => {
    expect(rubric).toMatch(/Implementation ACs per resolved decision/i);
    expect(rubric).toMatch(/commitment without a verification path/i);
    expect(rubric).toMatch(/decisions-need-acs/);
  });

  it("rubric 'what good looks like' includes the impl-AC coverage state", () => {
    expect(rubric).toMatch(/active implementation AC linked/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Channel E (BEHAVIOURAL, spec-392 ac-5) — the naked-decision computation. The
// guard used to grep services/acs.ts for the three eq() filter clauses
// (parent_kind='decision', kind='implementation', status='active'). Drop any
// clause and the rule silently changes shape, yet the source-grep would still
// pass if the strings stayed. We now EXERCISE the helper against a seeded
// fixture: a resolved decision is NAKED until an active implementation AC is
// linked, then it is covered.
// ───────────────────────────────────────────────────────────────────────────
describe("Channel E — listResolvedDecisionImplAcCoverage actually computes naked-vs-covered", () => {
  const createdDocIds: string[] = [];
  let memexId: string;

  beforeAll(async () => {
    memexId = await makeTestMemex("dec-need-acs-regr");
  });

  afterAll(async () => {
    for (const id of createdDocIds) {
      await db.delete(acs).where(eq(acs.briefId, id)).catch(() => {});
      await db.delete(decisions).where(eq(decisions.docId, id)).catch(() => {});
      await db.delete(documents).where(eq(documents.id, id)).catch(() => {});
    }
  });

  async function seedSpec(): Promise<string> {
    const doc = await createDocDraft(memexId, "decisions-need-acs regr", "purpose", "spec");
    createdDocIds.push(doc.id);
    return doc.id;
  }

  it("reports a resolved decision with no implementation AC as NAKED (count 0)", async () => {
    tagAc(AC(5));
    const specId = await seedSpec();
    const d = await createDecision(memexId, specId, "Naked resolved decision");
    await resolveDecision(memexId, d.id, "resolved");

    const out = await listResolvedDecisionImplAcCoverage(memexId, specId);
    expect(out).toHaveLength(1);
    expect(out[0].implementationAcCount).toBe(0);
  });

  it("reports the decision as covered once an active implementation AC is linked", async () => {
    tagAc(AC(5));
    const specId = await seedSpec();
    const d = await createDecision(memexId, specId, "Decision that gets an impl AC");
    await resolveDecision(memexId, d.id, "resolved");

    // Before: naked.
    let out = await listResolvedDecisionImplAcCoverage(memexId, specId);
    expect(out[0].implementationAcCount).toBe(0);

    await createAc({
      memexId,
      briefId: specId,
      kind: "implementation",
      statement: "verifies the decision",
      parent: { kind: "decision", id: d.id },
    });

    // After: covered — proof the (parent_kind='decision', kind='implementation',
    // status='active') filter actually fires, not merely that the clauses exist.
    out = await listResolvedDecisionImplAcCoverage(memexId, specId);
    expect(out[0].implementationAcCount).toBe(1);
  });

  it("excludes open (unresolved) decisions from the coverage set", async () => {
    tagAc(AC(5));
    const specId = await seedSpec();
    await createDecision(memexId, specId, "Still open");
    const out = await listResolvedDecisionImplAcCoverage(memexId, specId);
    expect(out).toEqual([]);
  });
});
