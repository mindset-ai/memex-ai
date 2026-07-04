import { Hono } from "hono";
import {
  cutVersion,
  getVersionSnapshot,
  listVersions,
  restoreVersion,
  getVersionOrPrimarySnapshot,
  CARRY_FORWARD_CLASSES,
  type CarryForwardClass,
  type SnapshotToken,
} from "../services/versioning.js";
import { type SessionEnv } from "../middleware/session.js";
import type { MemexResolverEnv } from "../middleware/memex-resolver.js";
import { requireMemexId, resolveReadableMemexId } from "./shared.js";
import { mountStandardSessionPolicy } from "./session-policy.js";
import { restCtx } from "./_actor-ctx.js";
import { parseJsonBodyOrNull, requireStringArray, requireStringType } from "./validation.js";
import { ValidationError } from "../types/errors.js";

// spec-448 t-6 — thin REST mirror of the versioning service (services/versioning.ts,
// t-2/t-3/t-4) + docViews (t-5's diff inputs). Mirrors the mounting/session-policy
// pattern of doc-assignees.ts / doc-members.ts: GET reads sit behind the permissive
// public session (each handler gates the memex via resolveReadableMemexId — public
// read / private 404, std-7); every mutating verb stays behind the strict session so
// a non-member can never reach a write.
//
// These endpoints are purely additive (ac-3): GET /docs/:id (routes/documents.ts)
// keeps resolving to the primary with no version specified — nothing here changes
// that default.
type Env = MemexResolverEnv & SessionEnv;
const versionsRouter = new Hono<Env>();
mountStandardSessionPolicy(versionsRouter);

const CARRY_FORWARD_SET: ReadonlySet<string> = new Set(CARRY_FORWARD_CLASSES);

function isCarryForwardClass(value: string): value is CarryForwardClass {
  return CARRY_FORWARD_SET.has(value);
}

// Body's carryForward is caller-supplied JSON — validate every entry is one of
// the five known classes rather than trusting it through to the service, which
// would silently no-op on an unrecognised string.
function parseCarryForward(raw: string[]): CarryForwardClass[] {
  for (const entry of raw) {
    if (!isCarryForwardClass(entry)) {
      throw new ValidationError(
        `carryForward entries must be one of: ${CARRY_FORWARD_CLASSES.join(", ")} (got "${entry}")`,
      );
    }
  }
  return raw as CarryForwardClass[];
}

// Version-number path/query segments arrive as strings; both the view-as-of GET
// and the diff GET need a strict-integer parse (no NaN/float/leading-junk) so a
// malformed value 400s here rather than reaching the service as garbage.
function parseVersionNumber(raw: string, label: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new ValidationError(`${label} must be a non-negative integer version number`);
  }
  return Number(raw);
}

// A diff side is either "primary" (the live current state) or a concrete
// version number (ac-26 — any two versions, including the primary).
function parseSnapshotToken(raw: string | undefined, label: string): SnapshotToken {
  if (raw === undefined || raw === "") {
    throw new ValidationError(`${label} is required (a version number or "primary")`);
  }
  if (raw === "primary") return "primary";
  return parseVersionNumber(raw, label);
}

// POST /doc/:docId — create a version. Body: { name, carryForward: string[] }.
// Returns the newly cut `document_versions` row (ac-1, ac-2, ac-14, ac-15).
versionsRouter.post("/doc/:docId", async (c) => {
  const memexId = requireMemexId(c);
  const docId = c.req.param("docId");
  const body = await parseJsonBodyOrNull<{ name?: unknown; carryForward?: unknown }>(c);
  // cutVersion itself re-validates (trims + rejects empty, ac-15) — this only
  // guards the wire type so a non-string doesn't reach the service as garbage.
  const name = requireStringType(body?.name, "name", {
    message: "Body must include a 'name' string",
  });
  const carryForwardRaw = requireStringArray(body?.carryForward, "carryForward", {
    message: "Body must include a 'carryForward' array of strings",
  });
  const carryForward = parseCarryForward(carryForwardRaw);

  const result = await cutVersion(memexId, docId, name, carryForward, restCtx(c));
  return c.json(result, 201);
});

// GET /doc/:docId — list every cut version, newest first (history/switcher feed).
versionsRouter.get("/doc/:docId", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const docId = c.req.param("docId");
  const result = await listVersions(memexId, docId);
  return c.json(result);
});

// GET /doc/:docId/diff?from=<N|primary>&to=<N|primary> — the two snapshots the
// UI diffs (ac-6, ac-26). Registered BEFORE the `:versionNumber` catch-all so
// the literal `diff` segment isn't swallowed by the param route.
versionsRouter.get("/doc/:docId/diff", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const docId = c.req.param("docId");
  const from = parseSnapshotToken(c.req.query("from"), "from");
  const to = parseSnapshotToken(c.req.query("to"), "to");

  const [fromSnapshot, toSnapshot] = await Promise.all([
    getVersionOrPrimarySnapshot(memexId, docId, from),
    getVersionOrPrimarySnapshot(memexId, docId, to),
  ]);
  return c.json({ from: fromSnapshot, to: toSnapshot });
});

// POST /doc/:docId/rollback — restore live content to a prior version's
// snapshot. Body: { sourceVersion }. Auto-freezes the pre-rollback state first
// (ac-20) and returns the newly materialised `document_versions` row, whose
// `restoredFromVersion` records provenance (ac-21, ac-22, ac-23). Registered
// BEFORE `:versionNumber` for the same literal-segment-first reason as `diff`.
versionsRouter.post("/doc/:docId/rollback", async (c) => {
  const memexId = requireMemexId(c);
  const docId = c.req.param("docId");
  const body = await parseJsonBodyOrNull<{ sourceVersion?: unknown }>(c);
  if (typeof body?.sourceVersion !== "number" || !Number.isInteger(body.sourceVersion)) {
    throw new ValidationError("Body must include an integer 'sourceVersion'");
  }
  const result = await restoreVersion(memexId, docId, body.sourceVersion, restCtx(c));
  return c.json(result);
});

// GET /doc/:docId/:versionNumber — view-as-of a specific frozen version
// (ac-4, ac-18, ac-25). Unknown doc or unknown version both 404 (std-7).
versionsRouter.get("/doc/:docId/:versionNumber", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const docId = c.req.param("docId");
  const versionNumber = parseVersionNumber(c.req.param("versionNumber"), "versionNumber");
  const result = await getVersionSnapshot(memexId, docId, versionNumber);
  return c.json(result);
});

export { versionsRouter };
