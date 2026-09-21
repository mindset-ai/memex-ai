// spec-510 t-1 (dec-2, dec-3, dec-7): the cross-instance session-claim store.
//
// Answers one question — "has this session already been sent this guidance?" —
// durably enough that the answer survives a change of serving process. Schema
// and the full rationale: migration 0152, and `agentSessionClaims` in db/schema.ts.
//
// This module is deliberately SHALLOW in surface and does all its thinking in
// SQL [per std-51 — depth at the interface, not line count]. Three functions:
//
//   recordGuidanceBytes — the seat reports what a response actually emitted
//   claimOnce           — a pure decision: may I send this, yes or no
//   readSessionClaims   — diagnostics and tests
//
// WHY THE TWO ARE SEPARATE, and this is a real fork rather than a detail. t-3
// calls `claimOnce` once per suppressible block on a response. If `claimOnce`
// also folded in the response's byte count, a response carrying six blocks would
// count its bytes six times and the dec-3 threshold would fire six times too
// early. The seat is where the response's size is actually known, so the seat
// records it ONCE and `claimOnce` only ever reads it.
//
// EVERY WRITE IS ONE STATEMENT [per std-39 — the write pattern is the
// load-bearing choice, not the schema], mirroring services/auth-rate-limit.ts.
// Concurrent instances serialise on the row lock rather than racing, so the
// failure that matters cannot happen: two instances each reading "not yet
// claimed" and each emitting the full block.
//
// CALL ORDER IS PART OF THE CONTRACT, and getting it wrong is silent. A granted
// claim stamps the session's byte total AS IT STANDS WHEN THE CLAIM IS MADE, so
// for one response:
//
//   claimOnce(...) first, then recordGuidanceBytes(...)
//     → the marker EXCLUDES the response that carried the block. "Bytes since
//       you were last shown this" then counts from just before that response,
//       which is what dec-3 describes.
//
//   recordGuidanceBytes(...) first, then claimOnce(...)
//     → the marker INCLUDES it, so every threshold effectively fires one
//       response's worth of bytes later.
//
// Neither is wrong in itself, but they differ, and nothing here can detect which
// the caller meant. t-3 should claim first and record after, and say so where
// the seat calls this.

// NOT A std-8 MUTATION, deliberately, and on the same footing as
// services/auth-rate-limit.ts. std-8 routes DOMAIN mutations through `mutate()`
// so they emit on the unified bus and live SSE subscribers refetch. A session
// claim is per-request infrastructure state: no surface renders it, no one
// subscribes to it, and an event per claim would put bus traffic on the hot path
// of every tool response for nothing. Neither function here returns
// `Promise<Mutated<T>>`, so the std-8 type brand and the `mutate-coverage`
// guards do not reach them — by construction, not by exemption.

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db/connection.js";

/**
 * When a granted claim becomes grantable again. Omit both fields for
 * "grant once per session, never again".
 *
 * The two mechanisms sharing this store need different backstops, which is why
 * this is a shape rather than a single number:
 *   - the full phase handoff re-primes on an idle interval (`ttlMs`), the
 *     behaviour spec-203 shipped and dec-7 preserves;
 *   - a static guidance block re-appears on VOLUME (`bytes`), because dec-3's
 *     safety net guards against context compaction, which is driven by how much
 *     text accumulated — not by elapsed time and not by call count.
 *
 * Passing both is legal; whichever condition is met first re-grants.
 */
export interface ClaimBackstop {
  /** Re-grant once this many milliseconds have elapsed since the last grant. */
  ttlMs?: number;
  /**
   * Re-grant once this many guidance bytes have been emitted to the session
   * SINCE THIS CLAIM was last granted — measured per claim, not globally, so a
   * block first seen mid-session is not instantly due.
   */
  bytes?: number;
}

export interface SessionClaimsView {
  guidanceBytes: number;
  claims: Record<string, { at: string; bytes: number; n: string }>;
}

/**
 * Record the guidance bytes one response emitted to a session, and return the
 * session's new running total. Called ONCE per response by the seat.
 *
 * Creates the session row if this is its first sighting.
 */
export async function recordGuidanceBytes(
  sessionId: string,
  bytes: number,
): Promise<number> {
  const rows = (await db.execute(sql`
    INSERT INTO agent_session_claims (session_id, guidance_bytes, updated_at)
    VALUES (${sessionId}, ${bytes}, now())
    ON CONFLICT (session_id) DO UPDATE SET
      guidance_bytes = agent_session_claims.guidance_bytes + ${bytes},
      updated_at = now()
    RETURNING guidance_bytes AS total
  `)) as unknown as Array<{ total: number | string }>;
  return Number(rows[0]?.total ?? 0);
}

/**
 * Claim the right to send `claimKey` to this session. Returns true exactly once
 * per session per claim — or again, once the backstop says the claim has gone
 * stale.
 *
 * ONE statement, so concurrent callers across instances cannot both win.
 *
 * How it reports the decision: `RETURNING` in an upsert can only see the NEW
 * row, so it cannot compare before-and-after. Each call therefore writes a
 * nonce with the claim and asks whether the stored nonce is its own — true only
 * if THIS call is the one that wrote it. That is unambiguous in a way that
 * comparing timestamps or byte markers is not (two calls in the same
 * millisecond, or a session with zero bytes recorded, both defeat those).
 */
export async function claimOnce(
  sessionId: string,
  claimKey: string,
  backstop: ClaimBackstop = {},
): Promise<boolean> {
  const nonce = randomUUID();
  const ttlMs = backstop.ttlMs ?? null;
  const bytes = backstop.bytes ?? null;

  const rows = (await db.execute(sql`
    INSERT INTO agent_session_claims (session_id, guidance_bytes, claims, updated_at)
    VALUES (
      ${sessionId},
      0,
      jsonb_build_object(
        ${claimKey}::text,
        jsonb_build_object('at', now(), 'bytes', 0, 'n', ${nonce}::text)
      ),
      now()
    )
    ON CONFLICT (session_id) DO UPDATE SET
      claims = CASE
        -- Never claimed in this session.
        WHEN agent_session_claims.claims -> ${claimKey}::text IS NULL
        -- Idle backstop: long enough since the last grant.
        OR (
          ${ttlMs}::bigint IS NOT NULL
          AND (agent_session_claims.claims -> ${claimKey}::text ->> 'at')::timestamptz
              <= now() - (${ttlMs}::bigint * INTERVAL '1 millisecond')
        )
        -- Volume backstop: enough guidance emitted since THIS claim was granted.
        OR (
          ${bytes}::bigint IS NOT NULL
          AND agent_session_claims.guidance_bytes
              - (agent_session_claims.claims -> ${claimKey}::text ->> 'bytes')::bigint
              > ${bytes}::bigint
        )
        -- The || operator MERGES one key into the existing object. Assigning the
        -- whole object instead would serialise correctly and still silently drop
        -- every concurrent sibling claim, which stays invisible until many
        -- blocks are in flight on one response.
        THEN agent_session_claims.claims || jsonb_build_object(
          ${claimKey}::text,
          jsonb_build_object(
            'at', now(),
            'bytes', agent_session_claims.guidance_bytes,
            'n', ${nonce}::text
          )
        )
        ELSE agent_session_claims.claims
      END,
      updated_at = now()
    RETURNING (claims -> ${claimKey}::text ->> 'n') = ${nonce}::text AS granted
  `)) as unknown as Array<{ granted: boolean }>;

  // A RETURNING upsert always yields exactly one row. If the driver ever hands
  // back nothing the write did not happen, and the safe reading is "not granted"
  // — the cost is re-sending guidance the agent may already have, which is what
  // the system did before this Spec. The opposite default would silently
  // suppress guidance on an infra blip.
  return rows[0]?.granted === true;
}

/** Read a session's row. Diagnostics and tests; production reads via claimOnce. */
export async function readSessionClaims(
  sessionId: string,
): Promise<SessionClaimsView> {
  const rows = (await db.execute(sql`
    SELECT guidance_bytes AS total, claims
    FROM agent_session_claims
    WHERE session_id = ${sessionId}
  `)) as unknown as Array<{ total: number | string; claims: SessionClaimsView["claims"] }>;
  const row = rows[0];
  return {
    guidanceBytes: Number(row?.total ?? 0),
    claims: row?.claims ?? {},
  };
}

/** Test hook: wipe the store so tests cannot leak into one another. */
export async function _resetSessionClaims(): Promise<void> {
  await db.execute(sql`TRUNCATE agent_session_claims`);
}
