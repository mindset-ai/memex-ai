// HTTP routes for the Emission Keys surface (spec-129).
//
// Tenant-scoped (mounted under /api/:namespace/:memex/emission-keys in app.ts). Every verb
// is a strict-session operation: emission keys are secrets, so even listing requires Memex
// membership (sessionMiddleware → requireMemexId sets currentMemexId only for members).
// There is NO adminGate — creation is a member capability (ac-18). There is no public read
// path and no anonymous-emission toggle (dec-3/dec-7).
//
// Member-level access matrix (dec-8), enforced here off `currentRole`:
//   - member        → create; list-own; revoke-own.
//   - administrator → create; list-all; revoke-any.
// "Own" is derived from memex_emission_keys.created_by_user_id (ac-19/20/21).
//
// Endpoints:
//   POST   /            — generate a key { name }. Returns the RAW key ONCE (ac-15).
//   GET    /            — list keys (role-scoped; metadata only, never hash/raw key).
//   POST   /:id/revoke  — soft-revoke (ownership-checked for members; never deletes).

import { Hono } from "hono";
import {
  mintEmissionKey,
  listEmissionKeysForMemex,
  listEmissionKeysForOwner,
  revokeEmissionKey,
} from "../services/emission-keys.js";
import { sessionMiddleware, type SessionEnv } from "../middleware/session.js";
import type { MemexResolverEnv } from "../middleware/memex-resolver.js";
import { requireMemexId } from "./shared.js";
import { ValidationError } from "../types/errors.js";
import type { MemexEmissionKey } from "../db/schema.js";

type Env = MemexResolverEnv & SessionEnv;

const emissionKeysRouter = new Hono<Env>();
emissionKeysRouter.use("/*", sessionMiddleware);

// Display-safe projection: metadata only. The hashed_key (the secret-at-rest) and the raw
// key are NEVER serialised to the client (ac-15). The raw key appears only in the POST /
// response, exactly once. `createdByUserId` is surfaced so the admin "see-all" view can
// attribute each key to its owner (and the client can badge the caller's own keys).
function toSafe(row: MemexEmissionKey) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.prefix,
    createdByUserId: row.createdByUserId,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
  };
}

emissionKeysRouter.post("/", async (c) => {
  const memexId = requireMemexId(c);
  // requireMemexId proves membership; sessionMiddleware guarantees a non-null user id.
  const createdByUserId = c.get("currentUserId") as string;
  const { name } = await c.req.json<{ name?: unknown }>();
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new ValidationError("name is required (non-empty string)");
  }
  const result = await mintEmissionKey(memexId, name.trim(), createdByUserId);
  // The ONLY time the raw key is ever returned. The client must copy it now; it is
  // unrecoverable afterwards (only the SHA-256 hash is stored).
  return c.json({ key: result.raw, ...toSafe(result.row) }, 201);
});

emissionKeysRouter.get("/", async (c) => {
  const memexId = requireMemexId(c);
  const isAdmin = c.get("currentRole") === "administrator";
  const userId = c.get("currentUserId") as string;
  const rows = isAdmin
    ? await listEmissionKeysForMemex(memexId)
    : await listEmissionKeysForOwner(memexId, userId);
  return c.json(rows.map(toSafe));
});

emissionKeysRouter.post("/:id/revoke", async (c) => {
  const memexId = requireMemexId(c);
  const isAdmin = c.get("currentRole") === "administrator";
  const userId = c.get("currentUserId") as string;
  const id = c.req.param("id");
  // Admins revoke any key on the Memex; members only their own (ownership filter). A member
  // revoking someone else's key matches no row → 404, identical to a non-existent key, so
  // it leaks nothing and changes no state (ac-20).
  const result = await revokeEmissionKey(
    id,
    memexId,
    isAdmin ? {} : { ownerUserId: userId },
  );
  if (!result) return c.json({ error: "Emission key not found" }, 404);
  return c.json(toSafe(result));
});

export { emissionKeysRouter };
