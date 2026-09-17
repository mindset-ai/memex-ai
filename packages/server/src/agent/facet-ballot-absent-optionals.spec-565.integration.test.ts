// spec-565 t-1 (dec-1) — a refusal for a missing ballot names EVERY absent optional,
// from the names the calling handler declares.
//
// The 2026-09-13 incident: nine `create_task` calls arrived carrying only ref/title/
// description. The server said "no facetBallot reached the server" and listed what did
// arrive — accurate, and still ballot-shaped, so the caller spent 42 minutes and three
// client restarts hunting a create_task-specific bug. The fact that would have ended it
// in one reply — that NO optional argument arrived, so nothing was dropped, the
// arguments were simply never sent — was computable from data the server already had
// and was never stated.
//
// `facet-ballot.ts` is tool-agnostic and must stay that way (dec-1), so the declared
// optional names travel handler → service. These tests drive `requireBallotForMemex`
// directly with an explicit declaredOptionals set, which is the seam the claim lives at.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  users,
  namespaces,
  orgs,
  orgMemberships,
  memexes,
  documents,
  facets,
} from "../db/schema.js";
import { z } from "zod";
import { requireBallotForMemex, nearMissBallotArg } from "../services/facet-ballot.js";
import { VERBOSE_FIELD, contentOptionalsOf } from "./handlers/tool-contract.js";
import { toolSpecs } from "./tool-specs.js";
import { ValidationError } from "../types/errors.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-565/acs/ac-${n}`;

/** The content-bearing optionals create_task declares (handlers/tasks.ts). `verbose` is
 *  NOT among them — it is the universal VERBOSE_FIELD, and naming it in a diagnosis
 *  about missing content would misdescribe the fault (dec-1). */
const CREATE_TASK_OPTIONALS = ["acceptanceCriteria", "sectionRef", "facetBallot"] as const;

let userId: string;
let memexId: string;

// std-37: per-worker-unique identifiers so parallel workers never collide.
const uniq = `x565-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();

const EMPTY_BALLOT = { verdict: {}, none: false };

beforeAll(async () => {
  const [u] = await db.insert(users).values({ email: `${uniq}@memex.ai` } as never).returning();
  userId = u.id;
  const [ns] = await db.insert(namespaces).values({ slug: uniq, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `Test ${uniq}` }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [mx] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: "Main" }).returning();
  memexId = mx.id;
  await db.insert(orgMemberships).values({ userId, orgId: org.id, role: "administrator" });

  // A vocabulary must exist or the ballot is not forced at all.
  for (const key of ["xc-security", "xc-perf"]) {
    await db.insert(facets).values({ ownerType: "org", ownerId: org.id, key, description: key });
  }

  await db
    .insert(documents)
    .values({ memexId, handle: "spec-1", title: "Consumer spec", docType: "spec", status: "build" })
    .returning();
});

afterAll(async () => {
  await db.delete(documents).where(eq(documents.memexId, memexId)).catch(() => {});
  await db.delete(memexes).where(eq(memexes.id, memexId)).catch(() => {});
  await db.delete(users).where(eq(users.id, userId)).catch(() => {});
});

/** Capture the rejection message from an absent-ballot guard call. */
async function absentBallotMessage(
  receivedArgNames: string[],
  declaredOptionals: readonly string[],
  noun: "decision" | "task" = "task",
) {
  try {
    await requireBallotForMemex(
      memexId,
      { provided: false, ballot: EMPTY_BALLOT, receivedArgNames },
      { noun, channel: "mcp", declaredOptionals },
    );
  } catch (err) {
    expect(err).toBeInstanceOf(ValidationError);
    return (err as Error).message;
  }
  throw new Error("expected requireBallotForMemex to reject an absent ballot");
}

describe("spec-565 dec-1 — the refusal names every absent optional", () => {
  it("names all three when a create_task call carries only its required arguments (ac-2, ac-6)", async () => {
    tagAc(AC(2));
    tagAc(AC(6));
    const msg = await absentBallotMessage(
      ["ref", "title", "description"],
      CREATE_TASK_OPTIONALS,
    );

    // Every declared optional is absent and every one is named. Asserting only
    // `facetBallot` would pass on today's code and prove nothing — these two are the
    // discriminating half.
    expect(msg).toContain("acceptanceCriteria");
    expect(msg).toContain("sectionRef");
    expect(msg).toContain("facetBallot");

    // And the SHAPE of the absence is stated, not left for the reader to infer from a
    // list. This is the sentence whose absence cost the incident its 42 minutes.
    expect(msg).toMatch(/NONE of .*optional arguments/i);
  });

  it("names only the optionals that are actually absent (ac-6)", async () => {
    tagAc(AC(6));
    const msg = await absentBallotMessage(
      ["ref", "title", "description", "acceptanceCriteria"],
      CREATE_TASK_OPTIONALS,
    );

    expect(msg).toContain("sectionRef");
    expect(msg).toContain("facetBallot");
    // acceptanceCriteria DID arrive, so it must not be reported as missing. It still
    // appears in the received-args echo, so scope the assertion to the absent clause.
    const absentClause = msg.slice(msg.indexOf("absent from this call"));
    expect(absentClause).not.toContain("acceptanceCriteria");

    // Not an all-absent call, so the all-absent wording must not fire.
    expect(msg).not.toMatch(/NONE of .*optional arguments/i);
  });

  it("never names `verbose` — it is the universal flag, not a content optional (ac-9)", async () => {
    tagAc(AC(9));
    const msg = await absentBallotMessage(
      ["ref", "title", "description"],
      CREATE_TASK_OPTIONALS,
    );
    expect(msg).not.toContain("verbose");
  });

  it("still echoes the argument names that did arrive — spec-499 dec-2 is preserved (ac-6)", async () => {
    tagAc(AC(6));
    const msg = await absentBallotMessage(
      ["ref", "title", "description"],
      CREATE_TASK_OPTIONALS,
    );
    expect(msg).toMatch(/No `facetBallot` argument reached the server/);
    expect(msg).toMatch(/The arguments it did receive were: ref, title, description\./);
  });
});

describe("spec-565 dec-1 — the dependency runs one way only", () => {
  it("services/facet-ballot.ts imports nothing from agent/handlers (ac-7)", () => {
    tagAc(AC(7));
    const src = readFileSync(
      new URL("../services/facet-ballot.ts", import.meta.url),
      "utf8",
    );
    const imports = src
      .split("\n")
      .filter((l) => /^\s*import\b/.test(l) || /\bfrom\s+["']/.test(l));

    // Option B (the service looking the tool up itself) would have inverted a
    // dependency that runs one way today — both handlers already import this module.
    for (const line of imports) {
      expect(line).not.toMatch(/agent\/handlers/);
      expect(line).not.toMatch(/\.\.\/agent\//);
    }
  });

  it("declaredOptionals is required at the type level on the create-verb entry point (ac-8)", () => {
    tagAc(AC(8));
    // This assertion is checked by `tsc`, not at runtime: if the parameter ever became
    // optional, the @ts-expect-error below would itself become an error ("unused
    // '@ts-expect-error' directive") and `make typecheck` would go red. A runtime test
    // cannot express "omitting this is a compile error", and a future verb silently
    // omitting it is exactly the std-50 default-in-silence dec-1 exists to prevent.
    //
    // Never invoked — declared only so the type checker sees the call shape.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const _omitsDeclaredOptionals = () =>
      requireBallotForMemex(
        memexId,
        { provided: false, ballot: EMPTY_BALLOT, receivedArgNames: [] },
        // @ts-expect-error declaredOptionals is required on requireBallotForMemex
        { noun: "task", channel: "mcp" },
      );
    expect(typeof _omitsDeclaredOptionals).toBe("function");
  });
});

// ─── spec-565 t-2 (dec-2, dec-3) ────────────────────────────────────────────
// The stale-tool-list hint is gone, and every branch now ends in a move the caller
// can make on its own next call.
//
// Enumerating the branches is the point. Asserting on one sample message would let a
// reintroduction slip into an unexercised branch while the guard stayed green — the
// same vacuous-pass shape this Spec exists to stamp out.

const FORBIDDEN = /reconnect|reload|cached\s+tool\s+list/i;

/** Every message `requireLead` can produce, across branch × channel. */
async function everyRefusalMessage(): Promise<Array<{ label: string; msg: string }>> {
  const cases: Array<{ label: string; received: string[]; noun: "task" | "decision" }> = [
    { label: "absent · no optional arrived", received: ["ref", "title", "description"], noun: "task" },
    { label: "absent · some optionals arrived", received: ["ref", "title", "description", "acceptanceCriteria"], noun: "task" },
    { label: "absent · no args at all", received: [], noun: "task" },
    { label: "near-miss · facet_ballot", received: ["ref", "title", "facet_ballot"], noun: "decision" },
    { label: "near-miss · FacetBallot", received: ["ref", "title", "FacetBallot"], noun: "decision" },
  ];
  const out: Array<{ label: string; msg: string }> = [];
  for (const c of cases) {
    for (const channel of ["mcp", "in_app_agent"] as const) {
      try {
        await requireBallotForMemex(
          memexId,
          { provided: false, ballot: EMPTY_BALLOT, receivedArgNames: c.received },
          { noun: c.noun, channel, declaredOptionals: CREATE_TASK_OPTIONALS },
        );
        throw new Error(`expected rejection for ${c.label}`);
      } catch (err) {
        if (!(err instanceof ValidationError)) throw err;
        out.push({ label: `${c.label} [${channel}]`, msg: (err as Error).message });
      }
    }
  }
  return out;
}

describe("spec-565 dec-2 — the refusal never sends the caller to fix its connection", () => {
  it("no branch, on any channel, mentions reconnecting or a cached tool list (ac-10, ac-1)", async () => {
    tagAc(AC(10));
    tagAc(AC(1));
    const all = await everyRefusalMessage();
    expect(all.length).toBe(10); // 5 branches × 2 channels — a shrunk set would fake a pass
    for (const { label, msg } of all) {
      expect(msg, `forbidden remediation leaked in: ${label}`).not.toMatch(FORBIDDEN);
    }
  });

  it("every branch ends in a move the caller can make on its own next call (ac-11)", async () => {
    tagAc(AC(11));
    const all = await everyRefusalMessage();
    for (const { label, msg } of all) {
      const actionable = label.startsWith("near-miss")
        ? /Re-send the same ballot under the exact name/i
        : /Re-send the call with `facetBallot`/i;
      expect(msg, `no actionable remedy in: ${label}`).toMatch(actionable);
    }
  });

  it("the message no longer varies by channel — the in-app agent path is unchanged (ac-12, ac-5)", async () => {
    tagAc(AC(12));
    tagAc(AC(5));
    const all = await everyRefusalMessage();
    // The suffix was the ONLY channel-dependent text, so with it gone the two channels
    // must be byte-identical. The in-app agent never carried it, which is exactly why
    // its output is the one that did not move.
    for (let i = 0; i < all.length; i += 2) {
      expect(all[i + 1].msg, `channel drift at ${all[i].label}`).toBe(all[i].msg);
    }
  });

  it("no test in the tree asserts the stale-tool-list sentence is PRESENT (ac-13, ac-14)", () => {
    tagAc(AC(13));
    tagAc(AC(14));
    // dec-3: the spec-499 presence-test is DELETED, not inverted — inverting it would
    // leave spec-499 ac-9 green on a statement the code contradicts. Its sibling, which
    // asserts the hint is ABSENT from the near-miss branch, survives untouched.
    const peer = readFileSync(
      new URL("./facet-ballot-diagnosis.spec-499.integration.test.ts", import.meta.url),
      "utf8",
    );
    expect(peer).not.toContain("keeps the stale-tool-list hint");
    // Scoped to POSITIVE assertions: `not.toMatch(/reconnect/i)` is the surviving
    // sibling's correct assertion and must not trip this guard. A blunt
    // /toMatch\(\/reconnect/ catches both and would have failed on the right code.
    const positiveReconnect = peer
      .split("\n")
      .filter((l) => /toMatch\(\/reconnect/.test(l) && !/\.not\.toMatch/.test(l));
    expect(positiveReconnect).toEqual([]);
    // The surviving sibling is still there, still tagged, still asserting absence.
    expect(peer).toContain("suppresses the stale-tool-list hint when a ballot demonstrably was sent");
  });
});

// ─── spec-565 t-3 (ac-3) ────────────────────────────────────────────────────
// The near-miss branch survived t-1 and t-2 unchanged.
//
// ac-3 is the only criterion in this Spec asserting something did NOT change, and both
// prior tasks rewrote this branch's immediate neighbours in the same function — t-1 the
// absent-branch lead, t-2 the suffix that used to hang off it. That is precisely where
// a silent regression lands, and precisely the kind of claim that gets assumed.
//
// Written to be falsifiable: asserting the message merely CONTAINS `facetBallot` would
// be true of every branch and prove nothing, so each assertion targets content only the
// near-miss branch produces. The mutation check for these lives in the task record.

const NEAR_MISS_SPELLINGS = ["facet_ballot", "facet-ballot", "FacetBallot", "Facet_Ballot"];

describe("spec-565 ac-3 — the near-miss branch is untouched by t-1 and t-2", () => {
  it("still names what arrived and what was expected, for every realistic spelling", async () => {
    tagAc(AC(3));
    for (const spelling of NEAR_MISS_SPELLINGS) {
      const msg = await absentBallotMessage(
        ["ref", "title", spelling],
        CREATE_TASK_OPTIONALS,
        "decision",
      );
      // Discriminating content: the received name itself, and the reason it was refused.
      expect(msg, spelling).toContain(spelling);
      expect(msg, spelling).toMatch(/DISCARDED because the name does not match/);
      expect(msg, spelling).toMatch(/Re-send the same ballot under the exact name/);
    }
  });

  // NOTE — there is deliberately no "rejected, never aliased" test here.
  //
  // One was written and DELETED after a mutation check exposed it as vacuous: it
  // asserted `/was NOT created/`, which lives in the preamble shared by every branch,
  // so it stayed green with the near-miss detector disabled outright. At this seam the
  // non-aliasing guarantee is not expressible — `requireBallotForMemex` is told
  // `provided: false` by the handler, so aliasing would have to happen upstream of it.
  //
  // The guarantee is real and IS covered, end-to-end and at the row level, by spec-499
  // ac-10 ("a complete ballot supplied under a near-miss key is rejected and creates no
  // decision or task row"), which drives executeServerTool. Keeping a second, weaker
  // assertion here would add a green badge and no evidence — the exact trade this Spec
  // exists to refuse.

  it("does not inherit t-1's absent-optional sentence — a ballot WAS sent here", async () => {
    tagAc(AC(3));
    const msg = await absentBallotMessage(["ref", "title", "facet_ballot"], CREATE_TASK_OPTIONALS, "decision");
    // t-1's sentence belongs to the branch where nothing ballot-shaped arrived. Listing
    // absent optionals here would bury the one fact that matters: the name was wrong.
    expect(msg).not.toMatch(/NONE of .*optional arguments/i);
    expect(msg).not.toMatch(/absent from this call/);
  });

  // The `facets` fall-through pin that stood here was DELETED by t-6, not reworded.
  // It existed to give issue-1 a baseline, and its own title asserted the fall-through —
  // renaming it would strand its identifier (std-48) and rewording it would leave a test
  // whose name contradicts its body. issue-1 is now delivered and ac-15 owns the
  // behaviour: `facets` is a near-miss, and a future `facet*` parameter is not.
});

// ─── spec-565 t-5 (ac-4) ────────────────────────────────────────────────────
// The named optionals are DERIVED from each verb's own Zod schema, not hand-listed.
//
// t-1 shipped literals at the call sites. Better-placed than a list buried in
// facet-ballot.ts, but still hand-maintained: add an optional to create_task's schema,
// forget the literal, and the refusal confidently describes a contract that no longer
// exists — exactly what ac-4 forbids.
//
// t-5's plan called for a std-16-style parity test binding the two. Zod 4 exposes
// `.isOptional()`, so they can be DEDUPED instead, which is strictly better: a parity
// test tells you the two disagree, derivation makes disagreement unrepresentable.
// `contentOptionalsOf` is that rule, named once, and these tests pin the rule itself —
// a test comparing a derived list against the same derivation would be tautological.

describe("spec-565 ac-4 — the optionals are derived from the schema, not hand-listed", () => {
  it("contentOptionalsOf keeps optionals, drops required, drops VERBOSE_FIELD by identity", () => {
    tagAc(AC(4));
    const shape = {
      ref: z.string(),
      title: z.string(),
      body: z.string().optional(),
      count: z.number().optional(),
      verbose: VERBOSE_FIELD,
    };
    expect(contentOptionalsOf(shape)).toEqual(["body", "count"]);
  });

  it("drops `verbose` by IDENTITY, not by name — a differently-named flag still counts", () => {
    tagAc(AC(4));
    // The exclusion rule is "this instance", the same invariant the tool-spec audit
    // already enforces on `spec.schema.verbose`. A name-based blacklist would wrongly
    // drop a real content optional that happened to be called `verbose`, and wrongly
    // keep a second VERBOSE_FIELD alias.
    expect(contentOptionalsOf({ verbose: z.boolean().optional() })).toEqual(["verbose"]);
    expect(contentOptionalsOf({ terse: VERBOSE_FIELD })).toEqual([]);
  });

  it("each create verb's refusal names exactly its schema's content optionals", async () => {
    tagAc(AC(4));
    for (const [name, noun] of [
      ["create_task", "task"],
      ["create_decision", "decision"],
    ] as const) {
      const spec = toolSpecs.find((s) => s.name === name);
      expect(spec, name).toBeDefined();
      const derived = contentOptionalsOf(spec!.schema);

      // Anchor: the derived set is what the live schema declares today. If someone adds
      // an optional, this reds and forces a conscious look rather than a silent drift.
      expect(derived, name).toEqual(
        name === "create_task"
          ? ["acceptanceCriteria", "sectionRef", "facetBallot"]
          : ["context", "status", "options", "facetBallot"],
      );

      // And the refusal names every one of them when none arrived.
      const msg = await absentBallotMessage(["ref", "title"], derived, noun);
      for (const optName of derived) expect(msg, `${name}/${optName}`).toContain(optName);
      expect(msg, name).not.toContain("verbose");
    }
  });
});

// ─── spec-565 t-6 (ac-15, from issue-1) ─────────────────────────────────────
// `facets` is caught as a near-miss.
//
// It is not an arbitrary typo. `facets` is the name of the tool whose entire job is to
// hand back the vocabulary, and whose own description ends "cast these as the
// facetBallot argument on create_task / create_decision". An agent that follows the
// documented procedure holds a list it just got from something called `facets`, and
// reaches for that word. One occurrence in 30 days of prod telemetry when this was
// filed — but the most PREDICTABLE wrong name there is, so the rate need not stay at 1.
//
// Matching is an explicit alias set, never a prefix rule. `startsWith("facet")` was
// tried as a t-3 mutation and would also swallow a future legitimate parameter — and a
// false positive there does not merely mislead, it REJECTS A VALID CALL.

describe("spec-565 ac-15 — `facets` is caught as a near-miss, not read as an absence", () => {
  it("names what arrived and what was expected, and says why it was discarded", async () => {
    tagAc(AC(15));
    const msg = await absentBallotMessage(
      ["ref", "title", "context", "facets"],
      CREATE_TASK_OPTIONALS,
      "decision",
    );
    expect(msg).toContain("facets");
    expect(msg).toContain("facetBallot");
    expect(msg).toMatch(/DISCARDED because the name does not match/);
    // It must NOT be diagnosed as a genuine absence any more.
    expect(msg).not.toMatch(/NONE of .*optional arguments/i);
  });

  it("is REJECTED, never read out of the misnamed argument (spec-499 dec-3)", async () => {
    tagAc(AC(15));
    // Reaching a message at all IS the rejection: absentBallotMessage throws if the
    // call did not reject. Asserting only that the message exists would be vacuous, so
    // assert the discriminating half — the caller is told to re-send under the right
    // name, not told its ballot was accepted.
    const msg = await absentBallotMessage(["ref", "title", "facets"], CREATE_TASK_OPTIONALS, "decision");
    expect(msg).toMatch(/Re-send the same ballot under the exact name/);
  });

  it("detects by an explicit alias set, not by prefix — a future `facet*` parameter survives", () => {
    tagAc(AC(15));
    expect(nearMissBallotArg(["facets"])).toBe("facets");
    // The trap this AC exists to prevent. A prefix rule catches `facets` AND these,
    // and swallowing a real parameter rejects a valid call rather than misleading.
    expect(nearMissBallotArg(["facetScope"])).toBeUndefined();
    expect(nearMissBallotArg(["facetVersion"])).toBeUndefined();
    expect(nearMissBallotArg(["facet"])).toBeUndefined();
    // And the spec-499 spellings still work, unchanged.
    expect(nearMissBallotArg(["facet_ballot"])).toBe("facet_ballot");
    expect(nearMissBallotArg(["FacetBallot"])).toBe("FacetBallot");
    expect(nearMissBallotArg(["facetBallot"])).toBeUndefined();
    expect(nearMissBallotArg(["ref", "title", "context"])).toBeUndefined();
  });
});
