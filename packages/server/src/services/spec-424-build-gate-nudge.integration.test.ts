// spec-424 t-2 (ac-11, ac-4, ac-14) — the build-gate grounding nudge recommends
// grounding, in every home, and the homes cannot drift apart.
//
// dec-3: the neutral closing sentence "Build transition is not blocked." reads
// as a permission. It is the LAST thing the agent reads after being told
// something is missing, and the last clause is what it retains. It becomes an
// explicit recommendation. The transition itself stays available — dec-3 keeps
// the gate advisory, spec-409 dec-6 depends on that, and ac-14 requires the
// availability to remain visible. So the sentence must carry BOTH, ordered so
// the recommendation is what closes it.
//
// ── WHY ONE TEST BODY, NOT THREE ──────────────────────────────────────────
// ac-11's load-bearing clause is "editing one copy and not the other goes RED".
// Split across separate tests, that claim quietly stops holding: a test that
// only reads the markdown home greens when the Scaffold home is left stale, and
// vice versa. Each half would pass on its own while the product contradicts
// itself — which is the exact half-delivered failure this task exists to
// prevent. So the composed assess_spec surface, the composed always-delivered
// footer, and the cross-home identity are asserted TOGETHER. Same reasoning,
// same shape, as spec-542's t-7 (`spec-542-grounding-interaction.integration.test.ts`),
// which records it in its own header.
//
// ── THE THREE HOMES ───────────────────────────────────────────────────────
// Confirmed by reading the source on this branch, not carried over from the
// task description:
//   1. `agent/phases/_base/code-grounding.md` → `nudge:not_verified`, parsed by
//      `parsePhaseDescriptions` into `CODE_GROUNDING_NUDGE` and pushed into the
//      assess_spec nudges. `phase-assessment.ts` is its ONLY consumer (grepped).
//   2. `@memex/shared` `scaffold-data.ts` → the node `code-grounding-not-grounded`,
//      targeted on `{ grounding: 'not_grounded' }`. This is the copy the agent
//      reads on every tool response. NOTE: NOT `BASE_CODE_GROUNDING`, which
//      spec-542 left holding the state-independent ASK — editing that one would
//      change the wrong text and this test would not catch it, so the ask is
//      asserted intact below.
//   3. `mcp/assessment-tools.integration.test.ts` hardcodes the sentence as an
//      expected value. Not a prose home — it is updated in the same change, and
//      its own suite is what proves it.
//
// ── ON THE APOSTROPHE ─────────────────────────────────────────────────────
// The two prose homes are compared byte-for-byte. That is only meaningful
// because both use U+0027 (checked with xxd before this test was written): the
// markdown holds a bare `'`, and the TypeScript literal holds `\'`, which is
// the same codepoint once the module is evaluated. The backslash is escaping,
// not content. If a typographic apostrophe (U+2019) is ever introduced into
// either home, this test reds — correctly, because the homes would then really
// have diverged.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tagAc } from "@memex-ai-ac/vitest";
import { BASE_SCAFFOLD, toNudge } from "@memex/shared";
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
import { parsePhaseDescriptions } from "../mcp/phase-descriptions.js";
import { createDocDraft } from "./documents.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-424/acs/ac-${n}`;

/** The sentence dec-3 removes. Asserted absent from every prose home. */
const NEUTRAL_SENTENCE = "Build transition is not blocked.";

/**
 * The recommendation that replaces it. Matched as a regex on the composed
 * output rather than as an equality against a constant: a change that keeps a
 * constant intact but stops DELIVERING it must go red, which is the failure
 * mode ac-11 names.
 */
const RECOMMENDATION = /grounding first is recommended/i;

/** The state-independent ask spec-542 split out. Must survive untouched. */
const THE_ASK = /Call assess_spec again with `codeGrounding`/;

/** The sibling claims this task must not touch. */
const GROUNDED_CLAIM = "Code-grounding affirmed by agent.";
const STALE_CLAIM = "Treat the grounding as out of date";

const PHASES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "agent",
  "phases",
);

/** The markdown home, parsed exactly the way the server parses it. */
function markdownNotVerified(): string {
  const sections = parsePhaseDescriptions(
    readFileSync(resolve(PHASES_DIR, "_base", "code-grounding.md"), "utf8"),
  );
  return sections["nudge:not_verified"];
}

/** The Scaffold home, read as the projection actually emits it. */
function scaffoldNotGrounded(): string {
  const node = BASE_SCAFFOLD.promptBlocks.find(
    (n) => n.id === "code-grounding-not-grounded",
  );
  if (!node) throw new Error("code-grounding-not-grounded is gone from BASE_SCAFFOLD");
  return node.text;
}

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

/**
 * An ungrounded Spec in `specify` — the only state whose block carries this prose.
 *
 * Returns the row ID alongside the ref, and the caller MUST read back by that ID.
 * `handle` is unique per Memex, NOT globally: every Memex numbers its Specs from
 * `spec-1`, so `findFirst({ where: eq(documents.handle, handle) })` matches an
 * arbitrary row across the other Memexes this suite's neighbours create. That
 * query passed when this file ran alone and failed in the full suite, reading a
 * different `spec-1` still sitting in `draft` — a std-37 isolation defect in the
 * test, wearing the costume of a broken transition.
 */
async function ungroundedSpec(title: string) {
  const doc = await createDocDraft(actor.memexId, title, "Purpose.", "spec");
  created.docs.push(doc.id);
  await db.update(documents).set({ status: "specify" }).where(eq(documents.id, doc.id));
  return { ref: `${actor.nsSlug}/main/specs/${doc.handle}`, id: doc.id };
}

let actor: Awaited<ReturnType<typeof setupActor>>;
beforeAll(async () => {
  actor = await setupActor("spec424-gate-nudge");
});

describe("spec-424 ac-11 — the build-gate nudge recommends grounding, in every home", () => {
  it("both composed surfaces drop the neutral sentence and carry the recommendation, and the two homes stay identical", async () => {
    tagAc(AC(11));
    tagAc(AC(14));

    const md = markdownNotVerified();
    const scaffold = scaffoldNotGrounded();

    // ── The cross-home identity. THIS is what makes editing one copy and not
    // the other go red: the two are a hand-maintained mirror (std-15 keeps them
    // in separate homes; dec-3 leaves them a copy rather than collapsing them),
    // so nothing but an assertion stops them diverging silently.
    expect(
      scaffold,
      "the two prose homes have diverged — one was edited without the other",
    ).toBe(md);

    // ── Neither home keeps the neutral closing sentence.
    expect(md, "the markdown home still ends on the neutral sentence").not.toContain(
      NEUTRAL_SENTENCE,
    );
    expect(scaffold, "the Scaffold home still ends on the neutral sentence").not.toContain(
      NEUTRAL_SENTENCE,
    );

    // ── Both carry the recommendation, and it CLOSES the text. dec-3's finding
    // is about ordering, not vocabulary: an agent told "something is missing"
    // and then "you may proceed" retains the permission. Asserting only that
    // the words appear somewhere would pass a sentence that still ends on the
    // permission, which is the defect wearing new words.
    expect(md).toMatch(RECOMMENDATION);
    expect(scaffold).toMatch(RECOMMENDATION);
    const tail = md.slice(md.search(RECOMMENDATION));
    expect(
      tail,
      "the recommendation is not the closing clause — the text still ends on the permission",
    ).not.toMatch(/\bnot blocked\b|\bremains available\b|\bis available\b/i);

    // ── SURFACE 1: the composed assess_spec({target:'build'}) response.
    const { ref: spec } = await ungroundedSpec("CG Gate Nudge");
    const assessed = await callTool(actor.user.id, "assess_spec", {
      ref: spec,
      mode: "phase",
      target: "build",
      codeGrounding: "not_verified",
    });
    expect(assessed.isError).toBeFalsy();
    const assessedText = textOf(assessed);
    expect(assessedText, "the assess_spec nudge lost the recommendation").toMatch(RECOMMENDATION);
    expect(
      assessedText,
      "the assess_spec nudge still delivers the neutral sentence",
    ).not.toContain(NEUTRAL_SENTENCE);

    // ── SURFACE 2: the always-delivered tool-response footer, composed for the
    // ungrounded state. This is the copy the agent reads on EVERY response, and
    // the half a markdown-only edit would leave stale.
    const footer = toNudge({
      dataset: BASE_SCAFFOLD,
      phase: "specify",
      grounding: "not_grounded",
    });
    expect(footer, "the footer lost the recommendation").toMatch(RECOMMENDATION);
    expect(footer, "the footer still delivers the neutral sentence").not.toContain(
      NEUTRAL_SENTENCE,
    );

    // ── spec-542's split is not re-fused. The state-independent ask survives,
    // and the two sibling claims are untouched: this task owns the ungrounded
    // branch only, and a rewrite that hedged across all three states would undo
    // what spec-542 shipped.
    expect(footer, "the state-independent ask was taken with the rewrite").toMatch(THE_ASK);
    expect(footer, "a grounded claim leaked into the ungrounded footer").not.toContain(
      GROUNDED_CLAIM,
    );
    expect(footer, "a stale claim leaked into the ungrounded footer").not.toContain(STALE_CLAIM);
  });

  // ── ac-4: the recommendation is advice, not a gate. dec-3 keeps the verdict
  // advisory and spec-409 dec-6 depends on it, so the stronger wording must not
  // have acquired teeth. Asserted by actually taking the transition.
  it("the specify→build transition still succeeds on an ungrounded Spec", async () => {
    tagAc(AC(4));

    const { ref: spec, id: specId } = await ungroundedSpec("CG Gate Never Blocks");
    const assessed = await callTool(actor.user.id, "assess_spec", {
      ref: spec,
      mode: "phase",
      target: "build",
      codeGrounding: "not_verified",
    });
    expect(assessed.isError).toBeFalsy();
    expect(textOf(assessed)).toMatch(RECOMMENDATION);

    const moved = await callTool(actor.user.id, "update_doc", { ref: spec, status: "build" });
    expect(moved.isError, "the recommendation acquired teeth — the gate now blocks").toBeFalsy();

    // By ID. `handle` is unique per Memex, not globally — see ungroundedSpec.
    const fresh = await db.query.documents.findFirst({
      where: eq(documents.id, specId),
    });
    expect(fresh!.status, "the transition did not land").toBe("build");
  });
});
