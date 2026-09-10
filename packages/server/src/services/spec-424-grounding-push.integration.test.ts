// spec-424 t-1 (ac-7, ac-8, ac-9, ac-10, ac-13; scope ac-1, ac-2, ac-3) — the
// always-delivered push to RECORD the grounding.
//
// THE GAP THIS CLOSES, stated so the test is not mistaken for a style check.
// `ground_spec` appears in delivered prose in exactly ONE place: inside the
// `plan-handoff` Prompt Button, which a HUMAN must copy into the session. An MCP
// coding agent that never copies it is never told the tool exists. spec-542 made
// the grounding CLAIM honest (it now says which state the Spec is in, with
// provenance); it did nothing about the CALL. That is what this delivers.
//
// ── dec-9: THE LINE IS THE CALL, NOT THE READ ─────────────────────────────
// An earlier plan had the line say BOTH "read the source behind the resolution
// you just settled" AND "record it with ground_spec". dec-9 dropped the first
// half: spec-542's state-keyed claim already says it, and says it better because
// it says it WITH the state. Two blocks in one response giving the same
// instruction in two voices is the duplication spec-33/dec-4 forbids and the
// byte-budget spec-193 dec-2 protects — and a footer the agent skims delivers
// nothing, which is the failure this whole Spec exists to fix. So the absence of
// a second read-the-source instruction is asserted, not assumed.
//
// ── THE UNCONDITIONAL CONSTRAINT (dec-2 survived dec-9) ───────────────────
// The line fires on EVERY resolve_decision, with no "latter part of specify"
// heuristic. That means it renders beside all THREE of spec-542's state-keyed
// claims — not_grounded, grounded, grounded_stale — so it has to read correctly
// against each. It is phrased conditionally ("once the resolved decisions are
// grounded, record it") precisely so it asserts nothing false in any of them:
// beside "affirmed" it is a no-op, beside "stale" it is the next move. Asserted
// in all three below rather than reasoned about.
//
// ── THE BRANCH THAT WOULD HAVE SWALLOWED IT ───────────────────────────────
// `renderFooterSignal`'s decision_resolved case is a ternary: when the decision
// has linked ACs, `acNudge` is the AC-test SKETCH; when it has none,
// `buildSketchBlock([])` returns "" and `acNudge` is the create-ACs prose.
// Appending the grounding line to that prose literal would have delivered it
// ONLY for decisions with no linked ACs — invisible in any single-fixture test,
// and wrong in exactly the case where the Spec is furthest along. It is a
// separate entry in the composed array instead, and BOTH branches are asserted.
//
// ── PLACEMENT (dec-1, std-15 cl-68) ───────────────────────────────────────
// Authored inside `renderFooterSignal`, not routed through the Scaffold: cl-68
// makes the per-(tool, phase, signal) footer composed logic with one authoring
// seat. `guidance-sole-author` and `guidance-authoring-confined` enforce that and
// are run as themselves; this file does not restate them. No STEER_BY_TOOL entry
// (dec-1's rejected option (b)) — pinned below, and note spec-542's own drift
// check already watches the adjacent property from the other side.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  memexes,
  namespaces,
  orgs,
  orgMemberships,
  documents,
  decisions,
  tasks,
  acs,
  users,
} from "../db/schema.js";
import { createMcpServer } from "../mcp/tools.js";
import { toolManifest, BASE_SCAFFOLD } from "@memex/shared";
import { createDocDraft } from "./documents.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-424/acs/ac-${n}`;

/** The call this Spec exists to deliver. */
const THE_CALL = /ground_spec/;
/** …and the instruction that it is a RECORDING move, not a suggestion to go read. */
const RECORD_MOVE = /record/i;

/**
 * dec-9's rejected half. spec-542's claims say "walk the resolved decisions
 * against current source" / "re-check the changed ones against current source";
 * neither uses this phrasing, so its presence would mean the nugget re-added its
 * own copy rather than deferring to them.
 */
const READ_THE_SOURCE_DUPLICATE = /read the source behind/i;

/** dec-8 / ac-13: decisions are not case law. No prior-decision-search reminder. */
const PRIOR_DECISION_SEARCH = /kind:\s*['"]decision['"]/i;

/** The impl-AC push that must keep LEADING the nugget (ac-9). */
const AC_PUSH = /create the implementation acceptance criteria|create_ac\(/;

const created = { users: [] as string[], memexes: [] as string[], docs: [] as string[] };

afterAll(async () => {
  if (created.docs.length) {
    await db.delete(acs).where(inArray(acs.briefId, created.docs)).catch(() => {});
    await db.delete(tasks).where(inArray(tasks.docId, created.docs)).catch(() => {});
    await db.delete(decisions).where(inArray(decisions.docId, created.docs)).catch(() => {});
    await db.delete(documents).where(inArray(documents.id, created.docs)).catch(() => {});
  }
  if (created.memexes.length)
    await db.delete(memexes).where(inArray(memexes.id, created.memexes)).catch(() => {});
  if (created.users.length)
    await db.delete(users).where(inArray(users.id, created.users)).catch(() => {});
});

// std-37: per-worker-unique identifiers, so parallel workers never collide.
async function setupActor(prefix: string) {
  const sub = `${prefix}-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 6)}`.toLowerCase();
  const [u] = await db.insert(users).values({ email: `${sub}@memex.ai` } as never).returning();
  created.users.push(u.id);
  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" }).returning();
  const [org] = await db
    .insert(orgs)
    .values({ namespaceId: ns.id, name: `Test ${sub}` })
    .returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [a] = await db
    .insert(memexes)
    .values({ namespaceId: ns.id, slug: "main", name: `Test ${sub}` })
    .returning();
  created.memexes.push(a.id);
  await db.insert(orgMemberships).values({ userId: u.id, orgId: org.id, role: "administrator" });
  return { user: u, memexId: a.id, nsSlug: ns.slug };
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

const textOf = (res: ToolResult) => res.content.map((c) => c.text).join("\n");

type Grounding = "none" | "grounded" | "stale";

/**
 * A specify-phase Spec carrying `count` open decisions.
 *
 * Read back by row ID, never by `handle`: handles are unique per Memex, not
 * globally, so a handle lookup matches an arbitrary neighbour under parallel
 * execution (std-37 — the defect this suite's sibling shipped and then fixed).
 *
 * `grounded_at` is stamped in the PAST because that is the only ordering
 * production can create: `ground_spec` stamps now(), so any later call is newer.
 * `resolve_decision` then mutates a row staleness derives from, which is why the
 * "grounded" fixture renders the STALE claim rather than the plain affirmative —
 * the same structural fact spec-542's t-7 records.
 */
async function specWithDecisions(title: string, count: number, grounding: Grounding = "none") {
  const doc = await createDocDraft(actor.memexId, title, "Purpose.", "spec");
  created.docs.push(doc.id);
  await db
    .update(documents)
    .set(
      grounding === "none"
        ? { status: "specify" }
        : {
            status: "specify",
            groundedInCode: true,
            groundedAt: new Date(Date.now() - 60_000),
            groundedByName: "A. Reviewer",
            groundedByUserId: actor.user.id,
          },
    )
    .where(eq(documents.id, doc.id));

  const decRefs: string[] = [];
  const ref = `${actor.nsSlug}/main/specs/${doc.handle}`;
  for (let i = 1; i <= count; i++) {
    const [dec] = await db
      .insert(decisions)
      .values({
        memexId: actor.memexId,
        docId: doc.id,
        seq: i,
        title: `Fork ${i} this Spec has to settle`,
        status: "open",
        source: "human",
      } as never)
      .returning();
    decRefs.push(`${ref}/decisions/dec-${dec.seq}`);
  }
  return { ref, id: doc.id, decRefs };
}

let actor: Awaited<ReturnType<typeof setupActor>>;
beforeAll(async () => {
  actor = await setupActor("spec424-push");
});

describe("spec-424 — the resolve_decision footer delivers the ground_spec call", () => {
  it("names ground_spec as a recording move, without re-adding a read-the-source instruction", async () => {
    tagAc(AC(7));
    tagAc(AC(13));
    tagAc(AC(1));
    tagAc(AC(3));

    const spec = await specWithDecisions("Push Basic", 1);
    const out = textOf(
      await callTool(actor.user.id, "resolve_decision", {
        ref: spec.decRefs[0],
        resolution: "Settled, with reasons.",
      }),
    );

    // ── The gap closed: the tool is NAMED on a surface nobody had to copy.
    expect(out, "the composed footer never names ground_spec").toMatch(THE_CALL);
    expect(out, "ground_spec is named but not as a recording move").toMatch(RECORD_MOVE);

    // ── dec-9's negative. Not decoration: option (a) — keeping both halves —
    // was live until this Spec was re-grounded, and re-adding it is the easiest
    // possible regression because it reads as helpful.
    expect(
      out,
      "the nugget re-added its own read-the-source instruction — dec-9 leaves that to spec-542's state-keyed claim",
    ).not.toMatch(READ_THE_SOURCE_DUPLICATE);

    // The instruction to consult source should reach the agent ONCE, from
    // spec-542's block. More than one occurrence means a second author appeared.
    const sourceMentions = out.match(/against current source/gi) ?? [];
    expect(
      sourceMentions.length,
      `"against current source" appears ${sourceMentions.length}x — one author, one instruction (spec-33/dec-4)`,
    ).toBeLessThanOrEqual(1);

    // ── ac-13 / dec-8: decisions are mutable and must not bind new work as case
    // law. The grounding axis stays code + standards, never prior decisions.
    expect(
      out,
      "a prior-decision-search reminder crept into the footer (ac-13, dec-8)",
    ).not.toMatch(PRIOR_DECISION_SEARCH);

    // ── ac-9: the existing push still LEADS. Appended, not prepended.
    const acAt = out.search(AC_PUSH);
    const groundAt = out.search(THE_CALL);
    expect(acAt, "the impl-AC push vanished from the nugget").toBeGreaterThan(-1);
    expect(
      acAt,
      "the grounding line displaced the impl-AC push instead of following it",
    ).toBeLessThan(groundAt);
  });

  // ── ac-10 / ac-2 / dec-2: frequency is structural, not heuristic.
  it("fires on the FIRST and the LAST decision alike — no latter-part-of-specify heuristic", async () => {
    tagAc(AC(10));
    tagAc(AC(2));

    const spec = await specWithDecisions("Push First And Last", 3);

    const first = textOf(
      await callTool(actor.user.id, "resolve_decision", {
        ref: spec.decRefs[0],
        resolution: "The first fork, settled.",
      }),
    );
    await callTool(actor.user.id, "resolve_decision", {
      ref: spec.decRefs[1],
      resolution: "The middle fork, settled.",
    });
    const last = textOf(
      await callTool(actor.user.id, "resolve_decision", {
        ref: spec.decRefs[2],
        resolution: "The last fork, settled.",
      }),
    );

    expect(first, "the push is missing on the FIRST decision").toMatch(THE_CALL);
    expect(
      last,
      "the push is missing on the LAST decision — a timing heuristic has crept in",
    ).toMatch(THE_CALL);
  });

  // ── The ternary branch. A single-fixture test cannot see this.
  it("fires whether or not the resolved decision has linked ACs (both ternary branches)", async () => {
    tagAc(AC(7));

    // Branch 1: no linked ACs → buildSketchBlock([]) === "" → acNudge is the
    // create-ACs prose.
    const bare = await specWithDecisions("Push No Linked ACs", 1);
    const bareOut = textOf(
      await callTool(actor.user.id, "resolve_decision", {
        ref: bare.decRefs[0],
        resolution: "Settled, no ACs linked yet.",
      }),
    );
    expect(bareOut, "the push is missing on a decision with no linked ACs").toMatch(THE_CALL);

    // Branch 2: linked ACs → acNudge IS the sketch block. Appending the grounding
    // line to the create-ACs literal would silently skip this branch — which is
    // the branch a Spec reaches once it is actually progressing.
    const withAc = await specWithDecisions("Push With Linked ACs", 1);
    await callTool(actor.user.id, "create_ac", {
      ref: withAc.ref,
      kind: "implementation",
      parent_decision_ref: withAc.decRefs[0],
      statement: "The mechanism behaves as the decision says.",
    });
    const withAcOut = textOf(
      await callTool(actor.user.id, "resolve_decision", {
        ref: withAc.decRefs[0],
        resolution: "Settled, with an AC already linked.",
      }),
    );
    expect(
      withAcOut,
      "the push is missing when the decision HAS linked ACs — it was appended to the wrong ternary branch",
    ).toMatch(THE_CALL);
  });

  // ── dec-9's drafting constraint, asserted rather than reasoned about.
  it("reads correctly beside every grounding state, since it is unconditional", async () => {
    tagAc(AC(7));

    for (const grounding of ["none", "grounded"] as const) {
      const spec = await specWithDecisions(`Push State ${grounding}`, 1, grounding);
      const out = textOf(
        await callTool(actor.user.id, "resolve_decision", {
          ref: spec.decRefs[0],
          resolution: "Settled.",
        }),
      );
      expect(out, `the push is missing when grounding is '${grounding}'`).toMatch(THE_CALL);
      expect(
        out,
        `the read-the-source duplicate appeared when grounding is '${grounding}'`,
      ).not.toMatch(READ_THE_SOURCE_DUPLICATE);
    }
  });


  // ── ac-9: the seat, and what the line must not displace ──────────────────
  // cl-68's two guards (guidance-sole-author, guidance-authoring-confined) are
  // their own files and assert their own claims; this pins the half specific to
  // THIS line — that it lives in the seat rather than the Scaffold, and that it
  // was APPENDED rather than put in front of the push that was already there.
  it("the line is authored in the renderFooterSignal seat, not the Scaffold, and does not displace the AC push", async () => {
    tagAc(AC(9));

    const handlersDir = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "agent",
      "handlers",
    );
    const envelope = readFileSync(resolve(handlersDir, "guidance-envelope.ts"), "utf8");

    // Inside renderFooterSignal's window — bounded by anchor, the way
    // guidance-authoring-confined bounds it, because the prose contains braces
    // that would fool a counter.
    const start = envelope.indexOf("async function renderFooterSignal(");
    const end = envelope.indexOf("export async function composeGuidanceEnvelope(", start);
    expect(start, "renderFooterSignal is gone").toBeGreaterThan(-1);
    expect(end, "could not bound renderFooterSignal").toBeGreaterThan(start);
    const seat = envelope.slice(start, end);
    expect(
      seat,
      "the grounding line is not authored inside the renderFooterSignal seat (std-15 cl-68)",
    ).toMatch(THE_CALL);

    // …and NOT routed through the Scaffold. cl-68 is a carve-out FROM cl-20,
    // so putting it in scaffold-data.ts would fight the carve-out and both
    // guards, and is the mistake an earlier draft of dec-1 made.
    //
    // Asserted against DELIVERED PROSE, not the raw file. An earlier version of
    // this guard counted `ground_spec` occurrences in scaffold-data.ts and
    // capped them at 2 — and spec-424's own t-3 reddened it by naming the tool
    // in a block's `rationale`, which is Inspect-only metadata no agent ever
    // reads. The claim is about what the Scaffold DELIVERS, so that is what is
    // inspected: prompt-block and guidance text. Prompt BUTTONS are excluded on
    // purpose — `plan-handoff` names the tool by design; it is the human-copied
    // surface that owns the instruction, which is exactly why the footer line
    // and the in-app CTA must not restate it.
    const deliveredProse = [
      ...BASE_SCAFFOLD.promptBlocks.map((b) => b.text),
      ...BASE_SCAFFOLD.baseGuidance.map((g) => g.text),
    ];
    const offenders = deliveredProse.filter((t) => /ground_spec/.test(t));
    expect(
      offenders,
      "the grounding call was routed through Scaffold-delivered prose instead of the cl-68 seat — " +
        "the Prompt Button is the one surface allowed to name it",
    ).toEqual([]);

    // The nugget it extends is still intact and still first.
    const spec = await specWithDecisions("Push Seat", 1);
    const out = textOf(
      await callTool(actor.user.id, "resolve_decision", {
        ref: spec.decRefs[0],
        resolution: "Settled.",
      }),
    );
    expect(out.search(AC_PUSH), "the impl-AC push was lost").toBeGreaterThan(-1);
    expect(
      out.search(AC_PUSH),
      "the grounding line displaced the impl-AC push instead of following it",
    ).toBeLessThan(out.search(THE_CALL));
  });

  // ── ac-5: one source, portable, and no std-16 ripple ─────────────────────
  it("adds no second copy of the instruction, stays portable, and leaves the tool contract untouched", () => {
    tagAc(AC(5));

    // std-16: the manifest contract is what a coding agent reads to learn the
    // tool's shape. This Spec changes prompting, not the contract.
    const entry = toolManifest.find((e) => e.name === "ground_spec");
    expect(entry, "ground_spec left the shared manifest").toBeDefined();
    expect(
      entry!.args,
      "the ground_spec signature changed — that is a std-16 ripple this Spec promised not to incur",
    ).toBe("ground_spec(ref, codebase_present)");

    // std-22: the line lands in agents working on arbitrary codebases. No paths,
    // no directory layout, no framework or runner names, no Standard handles.
    const envelope = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "..", "agent", "handlers", "guidance-envelope.ts"),
      "utf8",
    );
    const line = (envelope.match(/`Once the resolved decisions are grounded[^`]*`/) ?? [])[0];
    expect(line, "the grounding line could not be located for the portability check").toBeDefined();
    expect(line, "the line hardcodes a path or directory (std-22)").not.toMatch(
      /packages\/|src\/|\.ts\b|\/tests?\b/,
    );
    expect(line, "the line names a framework, runner or package manager (std-22)").not.toMatch(
      /vitest|jest|pytest|pnpm|npm |yarn|playwright/i,
    );
    expect(line, "the line cites a Standard by handle (std-22)").not.toMatch(/\bstd-\d+/i);
  });

  // ── ac-8 / dec-1's rejected option (b). spec-542's own drift check watches the
  // registry from the other side; this one pins the positive shape.
  it("STEER_BY_TOOL still holds exactly its one update_section entry", async () => {
    tagAc(AC(8));

    const src = readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        "..",
        "agent",
        "handlers",
        "guidance-envelope.ts",
      ),
      "utf8",
    );
    const start = src.indexOf("const STEER_BY_TOOL");
    const end = src.indexOf("function composeToolSteer", start);
    expect(start, "STEER_BY_TOOL has been renamed or removed").toBeGreaterThan(-1);
    expect(end, "could not bound the STEER_BY_TOOL registry").toBeGreaterThan(start);

    const registry = src.slice(start, end);
    const entries = registry.match(/^\s{2}[a-z_]+:/gm) ?? [];
    expect(
      entries.length,
      `STEER_BY_TOOL now registers ${entries.length} tools: ${entries.join(" ")} — dec-1 rejected adding one`,
    ).toBe(1);
    expect(registry, "the single entry is no longer update_section").toMatch(/update_section:/);
  });
});
