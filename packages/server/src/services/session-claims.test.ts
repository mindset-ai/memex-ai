// spec-510 t-1 (dec-2, dec-3, dec-7 — ac-10, ac-11) — the persisted session-claim store.
//
// The cadence needs to answer "have I already sent this to this session?" across
// Cloud Run instances. dec-2 chose Postgres over an in-memory Map on PRECEDENT,
// not preference: spec-349 exists because an in-memory Map "multiplied every limit
// by the Cloud Run instance count (3) and reset on cold start", and dec-7 then
// MEASURED the same defect in our own antecedent — `handoff-delivery.ts` delivers
// 2.672x against a contract of 1.
//
// So the two properties under test are exactly the two that an in-memory Map fails:
//   ac-10 — the claim is visible to a DIFFERENT backend (it is in Postgres at all)
//   ac-11 — concurrent claimants serialise on the row lock; exactly one wins
//
// Keys are worker-unique [per std-37] so parallel workers never collide.
import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  claimOnce,
  recordGuidanceBytes,
  readSessionClaims,
} from "./session-claims.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-510/acs/ac-${n}`;

let n = 0;
function sessionId(label = "s"): string {
  const worker = process.env.VITEST_POOL_ID ?? "0";
  return `${label}-w${worker}-${n++}-${Math.random().toString(36).slice(2)}`;
}

describe("session-claims — the claim itself", () => {
  it("grants the first claim and denies the second (ac-11)", async () => {
    tagAc(AC(11));
    const s = sessionId();
    expect(await claimOnce(s, "block:about-spec")).toBe(true);
    expect(await claimOnce(s, "block:about-spec")).toBe(false);
    expect(await claimOnce(s, "block:about-spec")).toBe(false);
  });

  it("namespaces claims — handoff:* and block:* in ONE row per session (ac-11)", async () => {
    tagAc(AC(11));
    const s = sessionId();
    expect(await claimOnce(s, "block:about-spec")).toBe(true);
    expect(await claimOnce(s, "handoff:spec-510:build")).toBe(true);

    // dec-7's key point: one row, two namespaces, no collision. Phase stays IN
    // the handoff key (spec-203 put it there deliberately) and OUT of the block
    // key (dec-3 excluded it deliberately) — which is only possible because the
    // namespaces are separate entries rather than one shared key space.
    const rows = (await db.execute(sql`
      SELECT count(*)::int AS rows FROM agent_session_claims WHERE session_id = ${s}
    `)) as unknown as Array<{ rows: number }>;
    expect(rows[0]?.rows).toBe(1);

    const claims = await readSessionClaims(s);
    expect(Object.keys(claims.claims).sort()).toEqual([
      "block:about-spec",
      "handoff:spec-510:build",
    ]);
    // Each claim carries BOTH markers — the claim TYPE decides which it reads.
    for (const key of Object.keys(claims.claims)) {
      expect(claims.claims[key]).toHaveProperty("at");
      expect(claims.claims[key]).toHaveProperty("bytes");
    }
  });
});

describe("session-claims — concurrency (ac-11)", () => {
  it("exactly ONE of many simultaneous claims on the SAME key wins", async () => {
    tagAc(AC(11));
    const s = sessionId();
    // The failure this guards against is BOTH winning — a read-modify-write race
    // where two instances each see "not claimed" and each emit the full block.
    const results = await Promise.all(
      Array.from({ length: 12 }, () => claimOnce(s, "block:standards-protocol")),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("simultaneous claims on DIFFERENT keys ALL win and none is lost", async () => {
    tagAc(AC(11));
    const s = sessionId();
    // The sibling failure, and the subtler one: a naive `SET claims = excluded.claims`
    // serialises correctly AND silently drops every concurrent sibling claim. It
    // stays invisible until t-3 has many blocks in flight on one response.
    const keys = Array.from({ length: 12 }, (_, i) => `block:b-${i}`);
    const results = await Promise.all(keys.map((k) => claimOnce(s, k)));
    expect(results.every(Boolean)).toBe(true);

    const claims = await readSessionClaims(s);
    expect(Object.keys(claims.claims).sort()).toEqual([...keys].sort());
  });
});

describe("session-claims — cross-backend durability (ac-10)", () => {
  it("a claim made on one backend is visible to another, and still denies a re-claim", async () => {
    tagAc(AC(10));
    const s = sessionId();
    expect(await claimOnce(s, "block:about-spec")).toBe(true);

    // A genuinely separate connection — its own pool, its own Postgres backend.
    // This is what an in-memory Map cannot do, and it is the whole of dec-2.
    const other = postgres(process.env.DATABASE_URL as string, { max: 1 });
    try {
      const [mine] = (await db.execute(
        sql`SELECT pg_backend_pid()::int AS pid`,
      )) as unknown as Array<{ pid: number }>;
      const theirs = await other`SELECT pg_backend_pid()::int AS pid`;

      // Prove the second read really is a different backend rather than asserting
      // it: a same-backend read would prove nothing about cross-instance state.
      expect(theirs[0].pid).not.toBe(mine.pid);

      const seen = await other`
        SELECT claims ? 'block:about-spec' AS present
        FROM agent_session_claims WHERE session_id = ${s}
      `;
      expect(seen[0].present).toBe(true);
    } finally {
      await other.end({ timeout: 5 });
    }

    // …and the claim still denies, which is the behaviour the agent experiences.
    expect(await claimOnce(s, "block:about-spec")).toBe(false);
  });
});

describe("session-claims — the two backstops (dec-3, dec-7)", () => {
  it("a TTL backstop re-grants only once the idle interval has elapsed", async () => {
    tagAc(AC(11));
    const s = sessionId();
    // The handoff's backstop (spec-203's 30-min idle TTL, carried by dec-7).
    expect(await claimOnce(s, "handoff:spec-510:build", { ttlMs: 60_000 })).toBe(true);
    expect(await claimOnce(s, "handoff:spec-510:build", { ttlMs: 60_000 })).toBe(false);
    // A zero-length window is "any elapsed time re-grants" — exercises the branch
    // without a sleep, the same trick auth-rate-limit's sub-second windows use.
    expect(await claimOnce(s, "handoff:spec-510:build", { ttlMs: 0 })).toBe(true);
  });

  it("a BYTES backstop re-grants on volume, not on time or call count (dec-3)", async () => {
    tagAc(AC(11));
    const s = sessionId();
    expect(await claimOnce(s, "block:about-spec", { bytes: 10_000 })).toBe(true);

    // Many tiny calls: dec-3's whole argument is that these must NOT re-grant.
    // Call count is the proxy it rejected — 50 calls, nowhere near the threshold.
    for (let i = 0; i < 50; i++) await recordGuidanceBytes(s, 100);
    expect(await claimOnce(s, "block:about-spec", { bytes: 10_000 })).toBe(false);

    // One large call takes the same session past the threshold. This is the
    // measured case: one get_doc returned 92,070 chars, worth ~300 create_acs.
    await recordGuidanceBytes(s, 92_070);
    expect(await claimOnce(s, "block:about-spec", { bytes: 10_000 })).toBe(true);

    // Re-granting RESETS the marker, so the next threshold is measured from here.
    expect(await claimOnce(s, "block:about-spec", { bytes: 10_000 })).toBe(false);
  });

  it("counts bytes per block, not globally — a block claimed later is not instantly due", async () => {
    tagAc(AC(11));
    const s = sessionId();
    expect(await claimOnce(s, "block:early", { bytes: 5_000 })).toBe(true);
    await recordGuidanceBytes(s, 9_000);

    // `block:late` is first seen when the session total is already 9,000. If the
    // threshold were measured against the session total rather than per-block,
    // it would be due immediately on its second sighting. It must not be.
    expect(await claimOnce(s, "block:late", { bytes: 5_000 })).toBe(true);
    expect(await claimOnce(s, "block:late", { bytes: 5_000 })).toBe(false);
    // …while `block:early`, seen 9,000 bytes ago, IS due.
    expect(await claimOnce(s, "block:early", { bytes: 5_000 })).toBe(true);
  });

  it("with NO backstop a claim is granted once and never again", async () => {
    tagAc(AC(11));
    const s = sessionId();
    expect(await claimOnce(s, "block:once")).toBe(true);
    await recordGuidanceBytes(s, 10_000_000);
    expect(await claimOnce(s, "block:once")).toBe(false);
  });
});

describe("session-claims — the byte counter is recorded once per response (ac-11)", () => {
  it("recordGuidanceBytes accumulates and claimOnce does NOT move the total", async () => {
    tagAc(AC(11));
    const s = sessionId();
    // The seat records the response's guidance bytes ONCE; claimOnce is a pure
    // decision over that total. Folding bytes into claimOnce would multiply the
    // total by the number of suppressible blocks on the response.
    expect(await recordGuidanceBytes(s, 1_000)).toBe(1_000);
    expect(await recordGuidanceBytes(s, 500)).toBe(1_500);

    await claimOnce(s, "block:a");
    await claimOnce(s, "block:b");
    await claimOnce(s, "block:c");

    const after = await readSessionClaims(s);
    expect(after.guidanceBytes).toBe(1_500);
  });
});
