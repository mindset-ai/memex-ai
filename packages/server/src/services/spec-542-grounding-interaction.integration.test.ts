// spec-542 t-7 (ac-4) — the spec-424 interaction, proven rather than assumed.
//
// ac-4's claim is an INTERACTION, and it says so: a grounding push that fires at
// Specs already grounded gets *worse* as spec-424's delivery gets better. So the
// claim is not "the push is gone" — it is that the push now travels with the
// state an agent needs to skip re-grounding, while an ungrounded Spec still gets
// pushed. A fix that suppressed the push everywhere would satisfy half of that
// and break spec-424 outright, which is why both directions are asserted in ONE
// test below rather than in two that could pass separately.
//
// WHY AN INTEGRATION TEST. The unit guards in @memex/shared prove `toNudge`
// discriminates; they say nothing about whether `resolve_decision` and
// `create_ac` responses actually carry the discriminated text. That is the
// claim ac-4 makes, so this drives the REAL tools through `createMcpServer`
// against REAL rows, with real grounding columns set.
//
// ───────────────────────────────────────────────────────────────────────────
// DRIFT FLAGGED (t-7 said to check before asserting, and to flag rather than
// test whatever is there now — so: the finding, recorded where it will be read).
//
// t-7's premise: "spec-424 … delivered on `resolve_decision` / `create_ac` via
// `STEER_BY_TOOL`". Checked, 2026-09-09:
//
//   • spec-424 is in BUILD with 0 of 3 tasks complete and 14 of 14 ACs
//     untested. It has shipped nothing. There is no per-tool grounding steer.
//   • `STEER_BY_TOOL` (agent/handlers/guidance-envelope.ts:98) still exists by
//     that name — but it holds exactly ONE entry, `update_section`. No
//     `resolve_decision` entry, no `create_ac` entry.
//   • The grounding push that DOES reach these two tools today is the global
//     ask in BASE_GUIDANCE (`id: 'code-grounding'`, `target: {}`) — matching
//     every tool and every phase. The other push is the specify handoff BUTTON
//     prose, a human→agent surface, not a per-tool steer.
//
// So the premise is drifted but the CLAIM is intact, and lands one layer down
// from where t-7 expected: the pushed ask reaches these tools globally, and
// after t-3 it travels with a state-keyed claim instead of a fixed one. That is
// what is asserted here. If spec-424 later adds per-tool entries, this test
// keeps holding — it asserts the response an agent reads, not the registry.
// ───────────────────────────────────────────────────────────────────────────
//
// ON "WATCHED FAIL, THEN PASS": the implementation landed in t-3/t-5, so this
// cannot be watched red against unfixed code. Red-CAPABILITY was proven instead
// by mutation, and this records the exact one that was run rather than a
// plausible-sounding one: changing the `not_grounded` guidance block's target
// from `{ grounding: 'not_grounded' }` back to `{}` in scaffold-data.ts — the
// original defect, restored — reds the both-directions test below on the
// grounded Spec being told it has no code-grounding. A test that cannot fail
// proves nothing (std-52), so that was executed and reverted, not assumed.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
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
import { createDocDraft } from "./documents.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-542/acs/ac-${n}`;

// The three claims, as an agent reads them in the response.
const UNGROUNDED_PUSH = /No code-grounding on this Spec/;
const GROUNDED_CLAIM = /Code-grounding affirmed by agent/;
const HEADER_VERIFIED = /Code-grounding: verified by /;
const HEADER_NONE = /Code-grounding: none —/;
// The state-INDEPENDENT ask. spec-424 depends on this surviving in BOTH
// directions: it is the specify→build gate prompt, not a claim about this Spec.
// If a future "fix" suppresses the push globally, this is what it would take
// with it, so it is asserted on the grounded side too.
const THE_ASK = /Call assess_spec again with `codeGrounding`/;

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
 * A specify-phase Spec with one open decision, grounded or not.
 *
 * `grounded` writes the real spec-409 columns rather than stubbing a derived
 * value — `groundedStale` is DERIVED per read from `grounded_at` vs the
 * decisions'/ACs' `updated_at`, so a stub would prove nothing about the
 * derivation this Spec depends on. `grounded_at` is set well in the future
 * relative to the rows so the fresh-grounding branch is the one exercised
 * (staleness has its own coverage in the shared guards).
 */
async function specWithDecision(title: string, grounded: boolean) {
  const doc = await createDocDraft(actor.memexId, title, "Purpose.", "spec");
  created.docs.push(doc.id);
  await db
    .update(documents)
    .set(
      grounded
        ? {
            status: "specify",
            groundedInCode: true,
            // Ahead of every child row's updated_at ⇒ derives NOT stale.
            groundedAt: new Date(Date.now() + 60_000),
            groundedByName: "A. Reviewer",
            groundedByUserId: actor.user.id,
          }
        : { status: "specify" },
    )
    .where(eq(documents.id, doc.id));
  const [dec] = await db
    .insert(decisions)
    .values({
      memexId: actor.memexId,
      docId: doc.id,
      seq: 1,
      title: "A fork this Spec has to settle",
      status: "open",
      source: "human",
    } as never)
    .returning();
  const ref = `${actor.nsSlug}/main/specs/${doc.handle}`;
  return { ref, decRef: `${ref}/decisions/dec-${dec.seq}` };
}

let actor: Awaited<ReturnType<typeof setupActor>>;
beforeAll(async () => {
  actor = await setupActor("spec542-interaction");
});

describe("spec-542 ac-4 — the grounding push carries state the agent can act on", () => {
  // ── BOTH DIRECTIONS, ONE TEST ────────────────────────────────────────────
  // Deliberately not split. Two separate tests would BOTH pass under a global
  // suppression of the push (each would only be checking its own half), and
  // that suppression is precisely the wrong fix ac-4 warns about. Asserting the
  // pair together means the only way to green is to actually discriminate.
  it("an already-grounded Spec is not pushed to re-ground, and an ungrounded one still is", async () => {
    tagAc(AC(4));

    const groundedSpec = await specWithDecision("Grounded Interaction Spec", true);
    const ungroundedSpec = await specWithDecision("Ungrounded Interaction Spec", false);

    const groundedOut = textOf(
      await callTool(actor.user.id, "resolve_decision", {
        ref: groundedSpec.decRef,
        resolution: "Settled against current source.",
        verbose: true,
      }),
    );
    const ungroundedOut = textOf(
      await callTool(actor.user.id, "resolve_decision", {
        ref: ungroundedSpec.decRef,
        resolution: "Settled against current source.",
        verbose: true,
      }),
    );

    // ── Direction 1: the grounded Spec is told it IS grounded, by whom, when.
    expect(
      groundedOut,
      "a grounded Spec resolving a decision is still being told it has no code-grounding — " +
        "this is the wasted re-grounding spec-424 would amplify",
    ).not.toMatch(UNGROUNDED_PUSH);
    expect(groundedOut, "the grounded claim never reached the response").toMatch(GROUNDED_CLAIM);
    expect(groundedOut, "the header does not name who grounded it or when").toMatch(
      HEADER_VERIFIED,
    );

    // ── Direction 2: the ungrounded Spec still gets pushed. Not suppressed.
    expect(
      ungroundedOut,
      "the ungrounded push is gone — that breaks spec-424, which exists to deliver it",
    ).toMatch(UNGROUNDED_PUSH);
    expect(ungroundedOut, "the ungrounded header line is missing").toMatch(HEADER_NONE);
    expect(ungroundedOut).not.toMatch(GROUNDED_CLAIM);

    // ── The state-independent ask survives BOTH ways ─────────────────────────
    // spec-424's whole delivery rides on this. If it only survived on the
    // ungrounded side, a grounded Spec would lose the specify→build gate
    // prompt — a regression dressed as a fix.
    expect(groundedOut, "the gate ask was lost on the grounded side").toMatch(THE_ASK);
    expect(ungroundedOut, "the gate ask was lost on the ungrounded side").toMatch(THE_ASK);

    // ── The two directions must actually DIFFER ──────────────────────────────
    // The root of the defect, stated at the level ac-4 cares about: before
    // spec-542 these two responses said the same thing about grounding.
    expect(
      groundedOut === ungroundedOut,
      "a grounded and an ungrounded Spec produced byte-identical resolve_decision output",
    ).toBe(false);
  });

  // create_ac is the second tool t-7 names. Same claim, different entry point —
  // because ac-4 is about what these tools' RESPONSES carry, and a fix wired
  // into only one handler would pass the test above.
  //
  // IT CARRIES THE CLAIM BUT NOT THE HEADER, and that asymmetry is real, not a
  // gap. `create_ac` returns a terse confirmation (`Created AC ...`) plus the
  // seat-composed footer — it never calls `formatState`, so the t-5 header line
  // has no seat in its response. `resolve_decision` DOES render full doc state,
  // which is why the test above can assert the header and this one cannot.
  //
  // ac-4 asks whether the response carries "the grounding state an agent can
  // act on". The footer claim is that state, and it discriminates correctly
  // here. So the absence of the header is asserted too, deliberately: it pins
  // the boundary instead of leaving a reader to wonder whether it was missed.
  it("create_ac carries the discriminated claim in both directions (footer, not header)", async () => {
    tagAc(AC(4));

    const groundedSpec = await specWithDecision("Grounded AC Spec", true);
    const ungroundedSpec = await specWithDecision("Ungrounded AC Spec", false);

    const mk = async (ref: string) =>
      textOf(
        await callTool(actor.user.id, "create_ac", {
          ref,
          kind: "scope",
          statement: "The interaction is proven rather than assumed.",
          verbose: true,
        }),
      );

    const groundedOut = await mk(groundedSpec.ref);
    const ungroundedOut = await mk(ungroundedSpec.ref);

    // ── Direction 1: grounded ⇒ the affirmative claim, and no re-ground push.
    expect(
      groundedOut,
      'create_ac on a grounded Spec still pushes it to re-ground',
    ).not.toMatch(UNGROUNDED_PUSH);
    expect(groundedOut, 'the grounded claim never reached create_ac').toMatch(GROUNDED_CLAIM);

    // ── Direction 2: ungrounded ⇒ the push still lands. Not suppressed.
    expect(
      ungroundedOut,
      'create_ac no longer pushes an ungrounded Spec — that is the global suppression ac-4 warns about',
    ).toMatch(UNGROUNDED_PUSH);
    expect(ungroundedOut).not.toMatch(GROUNDED_CLAIM);

    // The state-independent ask survives both ways here too.
    expect(groundedOut).toMatch(THE_ASK);
    expect(ungroundedOut).toMatch(THE_ASK);

    // The boundary, pinned: no doc-state header on either side, because this
    // handler does not render doc state. If create_ac ever starts calling
    // formatState, this reds and the comment above needs revisiting.
    expect(groundedOut, 'create_ac now renders the doc-state header — see the note above').not.toMatch(
      HEADER_VERIFIED,
    );
    expect(ungroundedOut).not.toMatch(HEADER_NONE);

    expect(
      groundedOut === ungroundedOut,
      'grounded and ungrounded create_ac responses were byte-identical',
    ).toBe(false);
  });

  // ── The drift finding, asserted so it cannot rot ─────────────────────────
  // t-7 asked for STEER_BY_TOOL to be confirmed by name OR the drift flagged.
  // A comment rots; this fails the day the premise becomes true, which is the
  // day someone should re-read the note at the top of this file.
  it("STEER_BY_TOOL exists by name and still registers NO grounding steer (drift check)", async () => {
    tagAc(AC(4));

    const { readFile } = await import("node:fs/promises");
    const src = await readFile(
      new URL("../agent/handlers/guidance-envelope.ts", import.meta.url),
      "utf8",
    );

    // Still exists by that name — the premise's one intact half.
    expect(src, "STEER_BY_TOOL has been renamed or removed — t-7's premise needs revisiting").toMatch(
      /const STEER_BY_TOOL\b/,
    );

    // And still holds no grounding entry. When spec-424 lands one, this reds and
    // the header note above stops being true.
    const registry = src.slice(
      src.indexOf("const STEER_BY_TOOL"),
      src.indexOf("function composeToolSteer"),
    );
    expect(registry.length, "could not isolate the STEER_BY_TOOL registry body").toBeGreaterThan(50);
    expect(
      /ground_spec|code-grounding|grounding/i.test(registry),
      "STEER_BY_TOOL now carries a grounding steer — spec-424 has shipped, so re-read this " +
        "file's header note: ac-4's interaction now has a second push to account for",
    ).toBe(false);
  });
});
