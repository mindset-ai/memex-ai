// spec-300 t-10 — REST routes for Skills. Tenant-scoped, mounted under
// /api/:namespace/:memex/skills in app.ts. The SAME service the MCP tools (later
// task) and the React UI wrap.
//
// Session policy (mountStandardSessionPolicy): GET reads run behind the permissive
// public session and gate the memex via resolveReadableMemexId (public read /
// private 404, std-7). Every mutating verb stays strict, so a non-member can never
// reach a write (they 404 at the membership check). Writes ADDITIONALLY require
// write access (dec-15): a read-level caller is refused.
//
//   GET    /skills                  — list active skills (metadata only)
//   GET    /skills/:handle          — one skill: verbatim SKILL.md + file TOC
//   POST   /skills                  — create a skill from SKILL.md (+ capabilities, files)
//   PATCH  /skills/:handle          — edit a skill's SKILL.md / capabilities
//   DELETE /skills/:handle          — archive (soft-delete) a skill
//   GET    /skills/:handle/files/*  — mint a signed read URL (or inline text) for one file

import { Hono } from "hono";
import { restCtx } from "./_actor-ctx.js";
import {
  createSkill,
  editSkill,
  archiveSkill,
  restoreSkill,
  getSkill,
  getSkillFile,
  listSkills,
  type SkillFileInput,
} from "../services/skills/skills-service.js";
import { draftSkillFromDescription } from "../services/skills/draft-skill.js";
import {
  getSkillUsageReport,
  getSkillsUsedForSpec,
} from "../services/skills/skill-metering.js";
import { publicSessionMiddleware, type SessionEnv } from "../middleware/session.js";
import type { MemexResolverEnv } from "../middleware/memex-resolver.js";
import { hookKeyOrSession } from "../middleware/hook-key-or-session.js";
import { ForbiddenError, ValidationError } from "../types/errors.js";
import { requireMemexId, resolveReadableMemexId } from "./shared.js";

type Env = MemexResolverEnv & SessionEnv;
const skillsRouter = new Hono<Env>();
// Session policy (std-7). GET reads run behind the permissive public session (public
// read / private 404 via resolveReadableMemexId). Write verbs go through
// hookKeyOrSession (spec-300 issue-5): a checkout HOOK KEY is accepted as an
// ALTERNATIVE to the web-session JWT, and when no hook key is present it delegates to
// the strict session middleware unchanged — so a non-member still 404s at the
// membership check. This is the standard mountStandardSessionPolicy wiring with the
// write half swapped for the hook-key-aware variant.
skillsRouter.on("GET", "/*", publicSessionMiddleware);
skillsRouter.on(["POST", "PUT", "PATCH", "DELETE"], "/*", hookKeyOrSession);

// dec-15 — a write needs write access. Membership is already proven by the strict
// session middleware (non-members 404); this refuses a read-level member (403).
function requireWriteMemexId(c: Parameters<typeof requireMemexId>[0] & {
  get: (k: "currentAccessLevel") => unknown;
}): string {
  const memexId = requireMemexId(c);
  if (c.get("currentAccessLevel") !== "write") {
    throw new ForbiddenError("Write access required");
  }
  return memexId;
}

// Decode + validate the raw JSON body into the service's file-input shape. Binary
// files arrive base64-encoded (JSON can't carry raw bytes); text files carry
// `text`. Exactly one of `text` / `contentBase64` per file.
function parseFiles(raw: unknown): SkillFileInput[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new ValidationError("`files` must be an array");
  }
  return raw.map((f, i): SkillFileInput => {
    if (typeof f !== "object" || f === null) {
      throw new ValidationError(`files[${i}] must be an object`);
    }
    const file = f as Record<string, unknown>;
    const path = typeof file.path === "string" ? file.path : "";
    if (!path) throw new ValidationError(`files[${i}].path is required`);
    const purpose = typeof file.purpose === "string" ? file.purpose : undefined;
    if (typeof file.contentBase64 === "string") {
      return {
        path,
        purpose,
        contentType: typeof file.contentType === "string" ? file.contentType : "application/octet-stream",
        bytes: Buffer.from(file.contentBase64, "base64"),
      };
    }
    if (typeof file.text === "string") {
      return {
        path,
        purpose,
        contentType: typeof file.contentType === "string" ? file.contentType : undefined,
        text: file.text,
      };
    }
    throw new ValidationError(`files[${i}] must carry either 'text' or 'contentBase64'`);
  });
}

// Decode a `removeFiles` JSON body value into a string[] of paths (spec-300 issue-7).
function parseRemoveFiles(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || !raw.every((p) => typeof p === "string")) {
    throw new ValidationError("`removeFiles` must be an array of file-path strings");
  }
  return raw as string[];
}

// spec-300 issue-6a — read a multipart/form-data create into the same CreateSkillInput
// the JSON path builds. Binary bytes ride as raw file parts (no base64-in-JSON):
//   - `skillMd`      : the SKILL.md text (required)
//   - `filename`     : optional original primary filename (drives the ac-9 guard)
//   - `capabilities` : optional JSON string of capability flags
//   - `files`        : zero or more file parts. A part whose content-type starts
//                      `text/` lands inline; every other part lands as binary bytes.
async function parseMultipartCreate(
  c: Parameters<typeof restCtx>[0],
): Promise<{ skillMd: string; capabilities?: unknown; files: SkillFileInput[]; filename?: string }> {
  const form = await c.req.parseBody({ all: true });

  const skillMd = form.skillMd;
  if (typeof skillMd !== "string" || skillMd.length === 0) {
    throw new ValidationError("`skillMd` part is required");
  }

  const filenameRaw = form.filename;
  const filename = typeof filenameRaw === "string" && filenameRaw.length > 0 ? filenameRaw : undefined;

  let capabilities: unknown;
  const capRaw = form.capabilities;
  if (typeof capRaw === "string" && capRaw.length > 0) {
    try {
      capabilities = JSON.parse(capRaw);
    } catch {
      throw new ValidationError("`capabilities` part must be valid JSON");
    }
  }

  const rawParts = form.files;
  const parts = rawParts === undefined ? [] : Array.isArray(rawParts) ? rawParts : [rawParts];
  const files: SkillFileInput[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      throw new ValidationError("Each `files` part must be an uploaded file, not a text field");
    }
    const path = part.name;
    if (!path) throw new ValidationError("A `files` part is missing its filename (path)");
    const contentType = part.type || "application/octet-stream";
    const bytes = new Uint8Array(await part.arrayBuffer());
    if (contentType.startsWith("text/")) {
      files.push({ path, contentType, text: Buffer.from(bytes).toString("utf8") });
    } else {
      files.push({ path, contentType, bytes });
    }
  }

  return { skillMd, ...(capabilities !== undefined ? { capabilities } : {}), files, ...(filename ? { filename } : {}) };
}

skillsRouter.get("/", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const skills = await listSkills(memexId);
  return c.json(skills);
});

// Usage reporting (spec-300 t-5 / dec-21). Registered BEFORE `/:handle` so the
// static `usage` segments never resolve as a skill handle.
//   GET /skills/usage           — hot/cold report: every active skill ranked by use
//   GET /skills/usage/by-spec   — inverse view: which skills a given Spec pulled
skillsRouter.get("/usage", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const report = await getSkillUsageReport(memexId);
  return c.json(report);
});

skillsRouter.get("/usage/by-spec", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const specRef = c.req.query("spec");
  if (!specRef) {
    throw new ValidationError("A `spec` query parameter (the working-Spec ref) is required");
  }
  const skills = await getSkillsUsedForSpec(memexId, specRef);
  return c.json(skills);
});

skillsRouter.get("/:handle", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  // A body fetch meters as a use (dec-21). Thread the actor/channel (rest_ui) and
  // an optional working-Spec ref so the usage event is attributed.
  const workingSpecRef = c.req.query("working_spec_ref");
  const skill = await getSkill(
    memexId,
    c.req.param("handle"),
    restCtx(c),
    workingSpecRef ? { workingSpecRef } : {},
  );
  return c.json(skill);
});

// The file path can contain slashes (e.g. `templates/index.html`), so it's a
// wildcard segment. Hono exposes it via c.req.path — slice off the route prefix.
skillsRouter.get("/:handle/files/*", async (c) => {
  const memexId = await resolveReadableMemexId(c);
  const handle = c.req.param("handle");
  const marker = `/skills/${handle}/files/`;
  const idx = c.req.path.indexOf(marker);
  const filePath = idx >= 0 ? decodeURIComponent(c.req.path.slice(idx + marker.length)) : "";
  if (!filePath) throw new ValidationError("A file path is required");
  const access = await getSkillFile(memexId, handle, filePath);
  return c.json(access);
});

// spec-300 t-15 Increment 1 (ac-49, closes ac-21) — agent-assisted authoring.
// Draft a spec-compliant SKILL.md from a plain-language description: the same
// describe→draft→validate turn the "Describe it" tab wires up. Persists NOTHING —
// draftSkillFromDescription runs the SAME validateSkill the create path runs, then
// hands the validated SKILL.md back; the UI persists it via POST /skills on confirm.
// Registered before `/:handle` verbs; `/draft` is a static segment (no handle
// collision). Write access required (dec-15) — it is an authoring precursor.
skillsRouter.post("/draft", async (c) => {
  requireWriteMemexId(c);
  const body = await c.req.json<{ description?: string }>();
  if (typeof body.description !== "string" || body.description.trim().length === 0) {
    throw new ValidationError("A plain-language `description` is required");
  }
  const draft = await draftSkillFromDescription(body.description);
  return c.json(draft);
});

// Create accepts TWO body shapes (spec-300 issue-6a):
//   - application/json  : the original path — text inline, binary as base64 in `files`.
//   - multipart/form-data: binary bytes upload as raw file parts (no base64), used by
//     `memex-ai skill push`. Both map to the SAME createSkill input.
skillsRouter.post("/", async (c) => {
  const memexId = requireWriteMemexId(c);
  const contentType = c.req.header("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const input = await parseMultipartCreate(c);
    const skill = await createSkill(memexId, input, restCtx(c));
    return c.json(skill, 201);
  }

  const body = await c.req.json<{
    skillMd?: string;
    capabilities?: unknown;
    files?: unknown;
    filename?: string;
  }>();
  if (typeof body.skillMd !== "string" || body.skillMd.length === 0) {
    throw new ValidationError("`skillMd` is required");
  }
  const skill = await createSkill(
    memexId,
    {
      skillMd: body.skillMd,
      capabilities: body.capabilities,
      files: parseFiles(body.files),
      // Passed through by the upload flow so a non-SKILL.md primary is rejected
      // before parsing (ac-9). Omitted by JSON authors handing raw SKILL.md text.
      ...(typeof body.filename === "string" ? { filename: body.filename } : {}),
    },
    restCtx(c),
  );
  return c.json(skill, 201);
});

// Edit accepts SKILL.md / capabilities, plus auxiliary-file add/replace (`files`) and
// removal (`removeFiles: string[]` of paths) — spec-300 issue-7.
skillsRouter.patch("/:handle", async (c) => {
  const memexId = requireWriteMemexId(c);
  const handle = c.req.param("handle");
  const body = await c.req.json<{
    skillMd?: string;
    capabilities?: unknown;
    files?: unknown;
    removeFiles?: unknown;
  }>();
  const files = parseFiles(body.files);
  const removeFiles = parseRemoveFiles(body.removeFiles);
  const skill = await editSkill(
    memexId,
    handle,
    {
      skillMd: body.skillMd,
      capabilities: body.capabilities,
      ...(files ? { files } : {}),
      ...(removeFiles ? { removeFiles } : {}),
    },
    restCtx(c),
  );
  return c.json(skill);
});

skillsRouter.delete("/:handle", async (c) => {
  const memexId = requireWriteMemexId(c);
  await archiveSkill(memexId, c.req.param("handle"), restCtx(c));
  return c.body(null, 204);
});

// Restore (un-archive) a soft-deleted skill — archiving is non-destructive, so
// the content is preserved and the skill re-surfaces in list/get + the agent
// catalogue (ac-10). Write access required (dec-15); an unknown/cross-Memex
// handle 404s (std-7).
skillsRouter.post("/:handle/restore", async (c) => {
  const memexId = requireWriteMemexId(c);
  const restored = await restoreSkill(memexId, c.req.param("handle"), restCtx(c));
  return c.json({ handle: restored.handle, name: restored.title });
});

export { skillsRouter };
