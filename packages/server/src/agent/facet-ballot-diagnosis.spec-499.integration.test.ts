// spec-499 t-2 (dec-2, dec-3) — the required-but-absent facet ballot is DIAGNOSED,
// not merely reported.
//
// "Absent" covers three different situations and the old message named only the one the
// server could see ("none was supplied"), with a remediation — reconnect your MCP client
// — that is right in at most one of them. These tests pin the discriminated branches:
// a near-miss argument name gets named and the cache hint suppressed; a genuine absence
// echoes the argument names that DID arrive and keeps the hint.
//
// The requireLead branches are exercised directly against `requireBallotForMemex` with
// channel 'mcp' (the surface the hint is written for), and end-to-end through
// executeServerTool for the handler wiring + the dec-3 "reject, never alias" guarantee.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
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
  decisions,
  tasks,
} from "../db/schema.js";
import { requireBallotForMemex, nearMissBallotArg } from "../services/facet-ballot.js";
import { ValidationError } from "../types/errors.js";
import { executeServerTool } from "./tools.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-499/acs/ac-${n}`;

let userId: string;
let memexId: string;
let specRef: string;
let specDocId: string;

// std-37: per-worker-unique identifiers so parallel workers never collide.
const uniq = `x499-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();

const COMPLETE = { verdict: { "xc-security": true, "xc-perf": false }, none: false };
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

  // A vocabulary must exist for the ballot to be forced at all.
  for (const key of ["xc-security", "xc-perf"]) {
    await db.insert(facets).values({ ownerType: "org", ownerId: org.id, key, description: key });
  }

  const [spec] = await db
    .insert(documents)
    .values({ memexId, handle: "spec-1", title: "Consumer spec", docType: "spec", status: "build" })
    .returning();
  specDocId = spec.id;
  specRef = `${uniq}/main/specs/spec-1`;
});

afterAll(async () => {
  await db.delete(documents).where(eq(documents.memexId, memexId)).catch(() => {});
  await db.delete(memexes).where(eq(memexes.id, memexId)).catch(() => {});
  await db.delete(users).where(eq(users.id, userId)).catch(() => {});
});

/** Capture the rejection message from an absent-ballot guard call. */
async function absentBallotMessage(receivedArgNames: string[] | undefined, noun: "decision" | "task") {
  try {
    await requireBallotForMemex(
      memexId,
      { provided: false, ballot: EMPTY_BALLOT, receivedArgNames },
      { noun, channel: "mcp" },
    );
  } catch (err) {
    expect(err).toBeInstanceOf(ValidationError);
    return (err as Error).message;
  }
  throw new Error("expected requireBallotForMemex to reject an absent ballot");
}

describe("spec-499 dec-2 — near-miss argument name is named, not guessed at", () => {
  it("names the key received and the key expected (ac-7)", async () => {
    tagAc(AC(7));
    tagAc(AC(1));
    const msg = await absentBallotMessage(["ref", "title", "facet_ballot"], "decision");
    expect(msg).toContain("facet_ballot"); // what arrived
    expect(msg).toContain("facetBallot"); // what was expected
    expect(msg).toMatch(/DISCARDED because the name does not match/);
    // The old lead actively misled — it asserted the caller supplied nothing.
    expect(msg).not.toMatch(/none was supplied/);
  });

  it("suppresses the stale-tool-list hint when a ballot demonstrably was sent (ac-9)", async () => {
    tagAc(AC(9));
    tagAc(AC(3));
    const msg = await absentBallotMessage(["ref", "title", "facet_ballot"], "decision");
    expect(msg).not.toMatch(/cached\s+tool list/);
    expect(msg).not.toMatch(/reconnect/i);
  });

  it("catches the realistic spelling variants, and only those (ac-7)", () => {
    tagAc(AC(7));
    expect(nearMissBallotArg(["ref", "facet_ballot"])).toBe("facet_ballot");
    expect(nearMissBallotArg(["facet-ballot"])).toBe("facet-ballot");
    expect(nearMissBallotArg(["FacetBallot"])).toBe("FacetBallot");
    expect(nearMissBallotArg(["Facet_Ballot"])).toBe("Facet_Ballot");
    // The correctly-spelled argument is not a near miss, and unrelated args are ignored.
    expect(nearMissBallotArg(["facetBallot"])).toBeUndefined();
    expect(nearMissBallotArg(["ref", "title", "context"])).toBeUndefined();
    expect(nearMissBallotArg(["facets"])).toBeUndefined();
    expect(nearMissBallotArg([])).toBeUndefined();
  });
});

describe("spec-499 dec-2 — a genuine absence is evidenced by what did arrive", () => {
  it("lists the argument names the server actually received (ac-8)", async () => {
    tagAc(AC(8));
    tagAc(AC(2));
    const msg = await absentBallotMessage(["ref", "title", "context"], "decision");
    expect(msg).toMatch(/No `facetBallot` argument reached the server/);
    expect(msg).toMatch(/The arguments it did receive were: ref, title, context\./);
  });

  it("keeps the stale-tool-list hint in the branch where a drop is actually possible (ac-9)", async () => {
    tagAc(AC(9));
    tagAc(AC(3));
    const msg = await absentBallotMessage(["ref", "title", "context"], "decision");
    expect(msg).toMatch(/cached\s+tool list/);
    expect(msg).toMatch(/reconnect\/reload the Memex MCP server/);
  });

  it("degrades gracefully when no argument names were threaded through (ac-8)", async () => {
    tagAc(AC(8));
    const msg = await absentBallotMessage(undefined, "decision");
    expect(msg).toMatch(/No `facetBallot` argument reached the server/);
    expect(msg).toMatch(/It received no arguments at all\./);
  });

  it("names create_task, not create_decision, on the task noun (ac-8)", async () => {
    tagAc(AC(8));
    const msg = await absentBallotMessage(["ref", "title", "description"], "task");
    expect(msg).toMatch(/create_task/);
    expect(msg).not.toMatch(/create_decision/);
    expect(msg).toMatch(/every task in this Memex/);
  });

  it("still re-hands the full vocabulary and ballot shape in both branches (ac-1, ac-2)", async () => {
    tagAc(AC(1));
    tagAc(AC(2));
    for (const received of [["ref", "facet_ballot"], ["ref", "title"]]) {
      const msg = await absentBallotMessage(received, "decision");
      expect(msg).toContain("xc-security");
      expect(msg).toContain("xc-perf");
      expect(msg).toMatch(/none:true for legitimate no-facet work/);
    }
  });
});

describe("spec-499 dec-3 — a misnamed ballot is rejected, never aliased", () => {
  it("create_decision rejects a complete ballot under a near-miss key and creates no row (ac-10)", async () => {
    tagAc(AC(10));
    const before = await db.select().from(decisions).where(eq(decisions.docId, specDocId));
    await expect(
      executeServerTool(
        memexId,
        "create_decision",
        { ref: specRef, title: "misnamed ballot", facet_ballot: COMPLETE },
        userId,
      ),
    ).rejects.toThrow(/facet_ballot/);
    const after = await db.select().from(decisions).where(eq(decisions.docId, specDocId));
    // Rejected BEFORE the write — no orphan decision, and nothing was coerced through.
    expect(after.length).toBe(before.length);
  });

  it("create_task rejects the same way and creates no row (ac-10)", async () => {
    tagAc(AC(10));
    const before = await db.select().from(tasks).where(eq(tasks.docId, specDocId));
    await expect(
      executeServerTool(
        memexId,
        "create_task",
        { ref: specRef, title: "misnamed", description: "d", facet_ballot: COMPLETE },
        userId,
      ),
    ).rejects.toThrow(/facet_ballot/);
    const after = await db.select().from(tasks).where(eq(tasks.docId, specDocId));
    expect(after.length).toBe(before.length);
  });

  it("never echoes argument VALUES back to the caller, only names (ac-8)", async () => {
    tagAc(AC(8));
    const secret = `sentinel-${uniq}-do-not-echo`;
    await expect(
      executeServerTool(
        memexId,
        "create_decision",
        { ref: specRef, title: secret, context: secret },
        userId,
      ),
    ).rejects.toThrow(
      expect.objectContaining({
        message: expect.not.stringContaining(secret) as unknown as string,
      }),
    );
  });
});

describe("spec-499 — correct callers are unaffected", () => {
  it("a complete ballot still creates the decision and returns the governing standards (ac-4)", async () => {
    tagAc(AC(4));
    const out = await executeServerTool(
      memexId,
      "create_decision",
      { ref: specRef, title: "properly balloted", facetBallot: COMPLETE },
      userId,
    );
    expect(out).toMatch(/Decision created/);
    const rows = await db.select().from(decisions).where(eq(decisions.docId, specDocId));
    expect(rows.some((d) => d.title === "properly balloted")).toBe(true);
  });

  it("an unknown extra argument alongside a correct ballot breaks nothing (ac-4)", async () => {
    tagAc(AC(4));
    const out = await executeServerTool(
      memexId,
      "create_decision",
      {
        ref: specRef,
        title: "balloted with extras",
        facetBallot: COMPLETE,
        somethingUndeclared: { nested: true },
      },
      userId,
    );
    expect(out).toMatch(/Decision created/);
  });
});
