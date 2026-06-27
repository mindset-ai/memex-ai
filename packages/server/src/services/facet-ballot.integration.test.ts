// spec-423 t-2 — the forced facet ballot (dec-5/dec-6): validation + storage.
// Pure-unit tests cover the validation algebra (no DB); integration tests cover the
// store round-trip + the re-hand on an invalid ballot against a real seeded vocab.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  documents,
  tasks,
  decisions,
  facets,
  taskFacetBallots,
  decisionFacetBallots,
  namespaces,
  memexes,
} from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";
import {
  validateBallot,
  validateBallotForMemex,
  castTaskBallot,
  castDecisionBallot,
  taskBallotTrueFacets,
  decisionBallotTrueFacets,
  type BallotInput,
} from "./facet-ballot.js";
import type { VocabFacet } from "./facet-vocab.js";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-423";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

const VOCAB: VocabFacet[] = [
  { id: "1", key: "security", description: "authz/tenancy/secrets" },
  { id: "2", key: "db-migrations", description: "schema & migrations" },
];

describe("ballot validation algebra (spec-423 t-2, dec-5)", () => {
  it("accepts a complete verdict and an explicit none (ac-13)", () => {
    tagAc(AC(13));
    expect(validateBallot({ verdict: { security: true, "db-migrations": false }, none: false }, VOCAB).ok).toBe(true);
    expect(validateBallot({ verdict: { security: false, "db-migrations": false }, none: true }, VOCAB).ok).toBe(true);
  });

  it("rejects empty / contradiction / incomplete / unknown-key (ac-13)", () => {
    tagAc(AC(13));
    const empty = validateBallot({ verdict: {}, none: false }, VOCAB);
    expect(empty).toMatchObject({ ok: false, reason: "empty" });

    const contradiction = validateBallot({ verdict: { security: true, "db-migrations": false }, none: true }, VOCAB);
    expect(contradiction).toMatchObject({ ok: false, reason: "contradiction" });

    const incomplete = validateBallot({ verdict: { security: true }, none: false }, VOCAB);
    expect(incomplete).toMatchObject({ ok: false, reason: "incomplete" });

    const unknown = validateBallot({ verdict: { security: true, "db-migrations": false, made_up: true }, none: false }, VOCAB);
    expect(unknown).toMatchObject({ ok: false, reason: "unknown_key" });

    // The all-false-without-none footgun is rejected too.
    const allFalse = validateBallot({ verdict: { security: false, "db-migrations": false }, none: false }, VOCAB);
    expect(allFalse).toMatchObject({ ok: false, reason: "empty" });
  });

  it("re-hands the live vocabulary in every rejection message (ac-13)", () => {
    tagAc(AC(13));
    const r = validateBallot({ verdict: {}, none: false }, VOCAB);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain("security");
      expect(r.message).toContain("db-migrations");
    }
  });
});

let memexId: string;
let orgId: string;
let specDocId: string;
let taskId: string;
let decisionId: string;

async function orgIdFor(mid: string): Promise<string> {
  const [row] = await db
    .select({ orgId: namespaces.ownerOrgId })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, mid))
    .limit(1);
  if (!row?.orgId) throw new Error("no org for test memex");
  return row.orgId;
}

beforeAll(async () => {
  memexId = await makeTestMemex("facbalcast");
  orgId = await orgIdFor(memexId);
  // Seed a two-facet vocabulary for the owner (keys not in the default set, so they
  // can't collide with autoseeded rows in a shared worker DB clone).
  await db.insert(facets).values([
    { ownerType: "org", ownerId: orgId, key: "xb-security", description: "authz" },
    { ownerType: "org", ownerId: orgId, key: "xb-migrations", description: "schema" },
  ]);
  const [doc] = await db
    .insert(documents)
    .values({ memexId, handle: "spec-facbalcast", title: "Ballot cast test", docType: "spec", status: "build" })
    .returning();
  specDocId = doc.id;
  const [task] = await db.insert(tasks).values({ memexId, docId: specDocId, seq: 1, title: "t", description: "d" }).returning();
  taskId = task.id;
  const [decision] = await db.insert(decisions).values({ memexId, docId: specDocId, seq: 1, title: "dec" }).returning();
  decisionId = decision.id;
});

afterAll(async () => {
  if (specDocId) await db.delete(documents).where(eq(documents.id, specDocId)).catch(() => {});
  await db.delete(facets).where(and(eq(facets.ownerType, "org"), eq(facets.ownerId, orgId))).catch(() => {});
});

describe("ballot storage against a real seeded vocabulary (spec-423 t-2, dec-5/dec-6)", () => {
  const ballot: BallotInput = { verdict: { "xb-security": true, "xb-migrations": false }, none: false };

  it("validateBallotForMemex resolves the owner vocab and throws a re-hand on an invalid ballot (ac-13)", async () => {
    tagAc(AC(13));
    // Incomplete against the LIVE (DB-resolved) vocab — must throw with the keys re-handed.
    await expect(
      validateBallotForMemex(memexId, { verdict: { "xb-security": true }, none: false }),
    ).rejects.toThrow(/xb-migrations/);
    // A complete ballot resolves the vocab without throwing.
    const vocab = await validateBallotForMemex(memexId, ballot);
    expect(new Set(vocab.map((v) => v.key))).toEqual(new Set(["xb-security", "xb-migrations"]));
  });

  it("casts + stores a task ballot (complete map + snapshot) and returns its true facets (ac-13)", async () => {
    tagAc(AC(13));
    const trueFacets = await castTaskBallot(memexId, specDocId, taskId, ballot, { channel: "mcp" });
    expect(trueFacets).toEqual(["xb-security"]);
    const [row] = await db.select().from(taskFacetBallots).where(eq(taskFacetBallots.taskId, taskId));
    expect(row.verdict).toEqual({ "xb-security": true, "xb-migrations": false });
    expect(new Set(row.vocabularyKeys)).toEqual(new Set(["xb-security", "xb-migrations"]));
    expect(row.channel).toBe("mcp");
    expect(await taskBallotTrueFacets(taskId)).toEqual(["xb-security"]);
  });

  it("casts a decision ballot into decision_facet_ballots — work-side, never precedent (ac-14)", async () => {
    tagAc(AC(14));
    await castDecisionBallot(memexId, specDocId, decisionId, ballot, { channel: "mcp" });
    const [row] = await db.select().from(decisionFacetBallots).where(eq(decisionFacetBallots.decisionId, decisionId));
    expect(row.verdict).toEqual({ "xb-security": true, "xb-migrations": false });
    expect(await decisionBallotTrueFacets(decisionId)).toEqual(["xb-security"]);
    // The decision's own row carries NO standards/precedent payload — only the work-side ballot.
    expect(Object.keys(row)).not.toContain("precedent");
  });

  it("re-casting a ballot upserts in place (one ballot per noun) (ac-13)", async () => {
    tagAc(AC(13));
    await castTaskBallot(memexId, specDocId, taskId, { verdict: { "xb-security": false, "xb-migrations": true }, none: false }, {});
    const rows = await db.select().from(taskFacetBallots).where(eq(taskFacetBallots.taskId, taskId));
    expect(rows).toHaveLength(1);
    expect(rows[0].verdict).toEqual({ "xb-security": false, "xb-migrations": true });
  });
});
