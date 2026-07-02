import { randomBytes, createHash } from "node:crypto";
import { eq, and, isNull, desc, sql } from "drizzle-orm";
import { db } from "../db/connection.js";
import { memexHookKeys, type MemexHookKey } from "../db/schema.js";
import { mutate, type Mutated } from "./mutate.js";
import type { ChangeEntity } from "./bus.js";

// spec-371 dec-6: the scoped HOOK credential. The least-privilege key the
// client-side checkout hook uses to authenticate its record-only phone-home
// (POST /api/spec-checkout/edit) and NOTHING else. Modeled on
// services/emission-keys.ts: per-Memex, hashed at rest (SHA-256 — 256-bit CSPRNG
// keys don't need a slow password hash), the prefix kept plaintext for a
// `mxh_xxxxxxxx…` settings display, soft-revoke (rows never hard-deleted).
//
// It is emphatically NOT the user's mxt_ PAT or the client's rotating OAuth token
// (which a shell hook can't reach anyway): a planted hook can fetch routing and
// report edits, full stop.
const KEY_PREFIX = "mxh_";
const KEY_RANDOM_BYTES = 32; // 256 bits of entropy

// Cheap shape test so a caller can decide whether a Bearer token is a hook key
// BEFORE the DB round-trip in verifyHookKey — used by hook-key-or-session middleware
// to distinguish "engage the hook-key path" from "fall through to the session JWT".
export function looksLikeHookKey(raw: string): boolean {
  return raw.startsWith(KEY_PREFIX);
}

// bus.ts owns the canonical ChangeEntity union; rather than edit it this wave we
// define the literal here and narrow at the single emit site — the same pattern
// the /api/test-events route uses for its TEST_EVENT_ENTITY.
const HOOK_KEY_ENTITY = "memex_hook_key" as ChangeEntity;

export function generateRawHookKey(): string {
  return KEY_PREFIX + randomBytes(KEY_RANDOM_BYTES).toString("base64url");
}

export function hashHookKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function hookKeyDisplayPrefix(raw: string): string {
  // First 8 chars after `mxh_` — enough to disambiguate without leaking the secret.
  return raw.slice(0, KEY_PREFIX.length + 8);
}

export interface MintedHookKey {
  raw: string;
  row: MemexHookKey;
}

// Mint a USER-scoped hook key (spec-430 dec-1 / dec-3). The minted row has
// `memexId: null` — it authorizes a checkout write for ANY memex its creator is an
// active member of, so a personal->org graduation needs no new key. `createdByUserId`
// is the scoping identity (the authenticated user the user-level mint endpoint
// resolved). There is NO memex anywhere: the reactivity emit fires non-scoped
// (memexId ""), mirroring bumpHookKeyLastUsed. Returns the RAW key exactly once — only
// the SHA-256 hash + prefix are persisted, so the raw value cannot be recovered after.
export async function mintHookKey(
  name: string,
  createdByUserId: string,
): Promise<Mutated<MintedHookKey>> {
  const raw = generateRawHookKey();
  return mutate(
    {},
    { memexId: "", userId: createdByUserId, entity: HOOK_KEY_ENTITY, action: "created" },
    async () => {
      const [row] = await db
        .insert(memexHookKeys)
        .values({
          memexId: null, // user-scoped (spec-430 dec-1); authz is by membership, not key granularity
          name,
          hashedKey: hashHookKey(raw),
          prefix: hookKeyDisplayPrefix(raw),
          createdByUserId,
        })
        .returning();
      return { raw, row };
    },
  );
}

// Returns the active key row iff the raw key matches an unrevoked record. A wrong
// prefix, an unknown key, or a revoked key (revokedAt set) all return null, so the
// caller 401s uniformly. The caller (the phone-home route) further confirms the
// key's memexId authorises the spec named in the request, and bumps lastUsedAt.
export async function verifyHookKey(raw: string): Promise<MemexHookKey | null> {
  if (!raw.startsWith(KEY_PREFIX)) return null;
  const hash = hashHookKey(raw);
  const row = await db.query.memexHookKeys.findFirst({
    where: and(eq(memexHookKeys.hashedKey, hash), isNull(memexHookKeys.revokedAt)),
  });
  return row ?? null;
}

// Fire-and-forget lastUsedAt heartbeat. Silent per std-8 §6 — a missed bump only
// leaves a stale timestamp, so it must never block or fail the request it rides.
export function bumpHookKeyLastUsed(keyId: string): void {
  void mutate(
    {},
    { memexId: "", entity: HOOK_KEY_ENTITY, action: "updated" },
    async () => {
      await db
        .update(memexHookKeys)
        .set({ lastUsedAt: sql`now()` })
        .where(eq(memexHookKeys.id, keyId));
    },
    { silent: true },
  ).catch((err) => {
    console.warn("[hook-keys] bumpHookKeyLastUsed failed", err);
  });
}

// Soft-revoke (sets revokedAt, never deletes) so the audit trail and sibling keys
// survive. Scoped to the OWNER (spec-430 dec-1): keys are user-scoped (memexId NULL),
// so a member revokes their own key by id + createdByUserId — a memex scope can no
// longer match a user-scoped row. Returns the updated row, or null when no row
// matches (wrong id, or not the caller's key).
export async function revokeHookKey(
  keyId: string,
  ownerUserId: string,
): Promise<Mutated<MemexHookKey | null>> {
  return mutate(
    {},
    { memexId: "", userId: ownerUserId, entity: HOOK_KEY_ENTITY, action: "deleted" },
    async () => {
      const [row] = await db
        .update(memexHookKeys)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(memexHookKeys.id, keyId), eq(memexHookKeys.createdByUserId, ownerUserId)))
        .returning();
      return row ?? null;
    },
  );
}

// Every key a USER owns, newest first (spec-430 dec-3 — keys are user-scoped, so the
// settings list is per user, never per memex).
export async function listHookKeysForUser(userId: string): Promise<MemexHookKey[]> {
  return db.query.memexHookKeys.findMany({
    where: eq(memexHookKeys.createdByUserId, userId),
    orderBy: [desc(memexHookKeys.createdAt)],
  });
}
