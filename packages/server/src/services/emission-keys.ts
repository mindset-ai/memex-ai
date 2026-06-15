import { randomBytes, createHash } from "node:crypto";
import { eq, and, isNull, or, gt, desc, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  memexEmissionKeys,
  memexes,
  namespaces,
  type MemexEmissionKey,
} from "../db/schema.js";
import { mutate, type Mutated } from "./mutate.js";

// Per-Memex AC-emission keys gating POST /api/test-events (spec-129). Modelled on
// services/mcp-tokens.ts, but memex-scoped rather than user-scoped: mint/revoke emit on
// the unified bus with memexId set (no userId) so the memex-scoped SSE channel reacts.
//
// Key shape: `mxk_<43 url-safe chars>`. The 32 random bytes give 256 bits of entropy
// (dec-1 / ac-6) — high-entropy enough that a fast SHA-256 hash is the correct at-rest
// form (dec-5), no slow password hash needed. Stored hashed; the prefix (first 8 chars
// after `mxk_`) is kept plaintext so the settings UI can show "mxk_a1b2c3d4…" without
// leaking the secret. The `mxk_` namespace makes leaked keys greppable in CI logs and
// eligible for GitHub secret-scanning.
const KEY_PREFIX = "mxk_";
const KEY_RANDOM_BYTES = 32; // 32 bytes → 256 bits of entropy (ac-6)

export function generateRawKey(): string {
  return KEY_PREFIX + randomBytes(KEY_RANDOM_BYTES).toString("base64url");
}

export function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function displayPrefix(raw: string): string {
  // First 8 chars after `mxk_` — enough to disambiguate in a settings list without
  // leaking the secret.
  return raw.slice(0, KEY_PREFIX.length + 8);
}

export interface MintedEmissionKey {
  raw: string;
  row: MemexEmissionKey;
}

// spec-234 dec-1: an agent-provisioned (ephemeral) key lives ~2h. Long enough to
// outlast a run-and-debug loop wired into the test process env at startup, so a key
// never expires mid-suite; short enough that the raw value — which does pass through
// the agent's MCP transcript — is worthless within hours.
export const EPHEMERAL_TTL_MS = 2 * 60 * 60 * 1000;

// spec-234 dec-5: ephemeral keys are named to mark their origin and tie them to the
// Spec, so a human auditing Settings → Emission Keys can tell them apart from durable
// CI keys at a glance. `<date>` is the UTC mint day.
export function ephemeralKeyName(specHandle: string, mintedAt: Date): string {
  return `agent · ${specHandle} · ${mintedAt.toISOString().slice(0, 10)}`;
}

// Shared insert for both key types. A permanent (CI) key passes neither `expiresAt`
// nor `scopedSpecHandle` (both NULL = today's spec-129 key). Returns the RAW key
// exactly once (ac-15): only the SHA-256 hash + prefix are persisted, so the raw
// value cannot be recovered afterwards.
async function insertEmissionKey(values: {
  memexId: string;
  name: string;
  createdByUserId: string;
  expiresAt?: Date | null;
  scopedSpecHandle?: string | null;
}): Promise<Mutated<MintedEmissionKey>> {
  const raw = generateRawKey();
  return mutate(
    {},
    {
      memexId: values.memexId,
      userId: values.createdByUserId,
      entity: "memex_emission_key",
      action: "created",
    },
    async () => {
      const [row] = await db
        .insert(memexEmissionKeys)
        .values({
          memexId: values.memexId,
          name: values.name,
          hashedKey: hashKey(raw),
          prefix: displayPrefix(raw),
          createdByUserId: values.createdByUserId,
          expiresAt: values.expiresAt ?? null,
          scopedSpecHandle: values.scopedSpecHandle ?? null,
        })
        .returning();
      return { raw, row };
    },
  );
}

// Mint a new PERMANENT (CI) emission key for a Memex — no expiry, whole-memex scope.
// This is the human-minted Settings-UI path (spec-129). `createdByUserId` records the
// minting member (ac-21) — it is what the list/revoke paths derive "own" from for the
// member-level access matrix (dec-8). Always set from the authenticated session at the
// call site; the column is nullable only for legacy rows.
export async function mintEmissionKey(
  memexId: string,
  name: string,
  createdByUserId: string,
): Promise<Mutated<MintedEmissionKey>> {
  return insertEmissionKey({ memexId, name, createdByUserId });
}

// spec-234 dec-1: mint an EPHEMERAL (agent) emission key — short-lived (EPHEMERAL_TTL_MS)
// and scoped to a single Spec. Minting NEVER revokes a prior key (non-exclusive): many
// ephemeral keys may be live at once so parallel agent sessions on one Spec don't disable
// each other, and TTL self-expiry — not revocation — keeps them from piling up. This is
// the only key path the provision_ac_emission MCP tool uses.
export async function mintEphemeralEmissionKey(
  memexId: string,
  specHandle: string,
  createdByUserId: string,
  opts: { now?: Date; ttlMs?: number } = {},
): Promise<Mutated<MintedEmissionKey>> {
  const now = opts.now ?? new Date();
  const expiresAt = new Date(now.getTime() + (opts.ttlMs ?? EPHEMERAL_TTL_MS));
  return insertEmissionKey({
    memexId,
    name: ephemeralKeyName(specHandle, now),
    createdByUserId,
    expiresAt,
    scopedSpecHandle: specHandle,
  });
}

// Returns the active key row if the raw key matches an unrevoked, UNEXPIRED record
// (ac-13: a revoked key — revokedAt set — never matches; spec-234 ac-10: an expired key
// — expiresAt in the past — never matches either). A NULL expiresAt is permanent and
// always passes the expiry test, so spec-129 CI keys are unaffected. Caller (the
// /api/test-events route) further confirms the row's memexId matches the ac_uid, applies
// any spec scope, and bumps lastUsedAt. Returns null on any miss so the caller 401s
// uniformly.
export async function verifyEmissionKey(
  raw: string,
): Promise<MemexEmissionKey | null> {
  if (!raw.startsWith(KEY_PREFIX)) return null;
  const hash = hashKey(raw);
  const row = await db.query.memexEmissionKeys.findFirst({
    where: and(
      eq(memexEmissionKeys.hashedKey, hash),
      isNull(memexEmissionKeys.revokedAt),
      or(
        isNull(memexEmissionKeys.expiresAt),
        gt(memexEmissionKeys.expiresAt, sql`now()`),
      ),
    ),
  });
  return row ?? null;
}

// Fire-and-forget lastUsedAt heartbeat (ac-17). Silent per std-8 §6 — a missed bump only
// leaves a stale timestamp, so it must never block or fail the emission it's attached to.
export function bumpLastUsed(keyId: string): void {
  void mutate(
    {},
    { memexId: "", entity: "memex_emission_key", action: "updated" },
    async () => {
      await db
        .update(memexEmissionKeys)
        .set({ lastUsedAt: sql`now()` })
        .where(eq(memexEmissionKeys.id, keyId));
    },
    { silent: true },
  ).catch((err) => {
    console.warn("[emission-keys] bumpLastUsed failed", err);
  });
}

// Resolve the memex_id named by an emission's ac_uid. ac_uid is
// `<namespace>/<memex>/specs/spec-N/acs/ac-M`; the (namespace, memex) slug pair maps to
// exactly one memex row. Returns null when the pair names no known memex. Used by the
// /api/test-events auth path to confirm a key only authorises its OWN Memex (ac-10).
export async function resolveMemexId(
  namespaceSlug: string,
  memexSlug: string,
): Promise<string | null> {
  if (!namespaceSlug || !memexSlug) return null;
  const rows = await db
    .select({ id: memexes.id })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(and(eq(namespaces.slug, namespaceSlug), eq(memexes.slug, memexSlug)))
    .limit(1);
  return rows[0]?.id ?? null;
}

// Admin view (ac-19): every key on the Memex, newest first. Prefix-only metadata is the
// caller's responsibility (the route's toSafe projection) — this returns full rows.
export async function listEmissionKeysForMemex(
  memexId: string,
): Promise<MemexEmissionKey[]> {
  return db.query.memexEmissionKeys.findMany({
    where: eq(memexEmissionKeys.memexId, memexId),
    orderBy: [desc(memexEmissionKeys.createdAt)],
  });
}

// Member view (ac-19): only the keys this member created on this Memex. "Own" is derived
// from created_by_user_id (ac-21). Legacy keys with a null creator belong to nobody and so
// never appear in any member's list — only admins (listEmissionKeysForMemex) see them.
export async function listEmissionKeysForOwner(
  memexId: string,
  ownerUserId: string,
): Promise<MemexEmissionKey[]> {
  return db.query.memexEmissionKeys.findMany({
    where: and(
      eq(memexEmissionKeys.memexId, memexId),
      eq(memexEmissionKeys.createdByUserId, ownerUserId),
    ),
    orderBy: [desc(memexEmissionKeys.createdAt)],
  });
}

// Soft-revoke (sets revokedAt, never deletes) so the key list + audit trail stay intact and
// sibling keys keep working (dec-4). Always scoped to the owning Memex; the caller passes
// `ownerUserId` to additionally require the key was created by that member (the member
// "revoke-own" path, ac-20). Admins omit it (memex-scope only → "revoke-any"). Returns the
// updated row, or null when no row matches — which is BOTH "no such key" and "a member
// tried to revoke a key they don't own"; the route renders either as 404, leaking nothing
// about keys outside the caller's view (ac-20: no state change on an unauthorised revoke).
export async function revokeEmissionKey(
  keyId: string,
  memexId: string,
  opts: { ownerUserId?: string } = {},
): Promise<Mutated<MemexEmissionKey | null>> {
  const ownershipFilter = opts.ownerUserId
    ? [eq(memexEmissionKeys.createdByUserId, opts.ownerUserId)]
    : [];
  return mutate(
    {},
    {
      memexId,
      ...(opts.ownerUserId ? { userId: opts.ownerUserId } : {}),
      entity: "memex_emission_key",
      action: "deleted",
    },
    async () => {
      const [row] = await db
        .update(memexEmissionKeys)
        .set({ revokedAt: sql`now()` })
        .where(
          and(
            eq(memexEmissionKeys.id, keyId),
            eq(memexEmissionKeys.memexId, memexId),
            ...ownershipFilter,
          ),
        )
        .returning();
      return row ?? null;
    },
  );
}
