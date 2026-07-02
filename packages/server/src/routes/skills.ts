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
  getSkill,
  getSkillFile,
  listSkills,
  type SkillFileInput,
} from "../services/skills/skills-service.js";
import {
  getSkillUsageReport,
  getSkillsUsedForSpec,
} from "../services/skills/skill-metering.js";
import { type SessionEnv } from "../middleware/session.js";
import type { MemexResolverEnv } from "../middleware/memex-resolver.js";
import { ForbiddenError, ValidationError } from "../types/errors.js";
import { requireMemexId, resolveReadableMemexId } from "./shared.js";
import { mountStandardSessionPolicy } from "./session-policy.js";

type Env = MemexResolverEnv & SessionEnv;
const skillsRouter = new Hono<Env>();
mountStandardSessionPolicy(skillsRouter);

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

skillsRouter.post("/", async (c) => {
  const memexId = requireWriteMemexId(c);
  const body = await c.req.json<{
    skillMd?: string;
    capabilities?: unknown;
    files?: unknown;
  }>();
  if (typeof body.skillMd !== "string" || body.skillMd.length === 0) {
    throw new ValidationError("`skillMd` is required");
  }
  const skill = await createSkill(
    memexId,
    { skillMd: body.skillMd, capabilities: body.capabilities, files: parseFiles(body.files) },
    restCtx(c),
  );
  return c.json(skill, 201);
});

skillsRouter.patch("/:handle", async (c) => {
  const memexId = requireWriteMemexId(c);
  const handle = c.req.param("handle");
  const body = await c.req.json<{ skillMd?: string; capabilities?: unknown }>();
  const skill = await editSkill(
    memexId,
    handle,
    { skillMd: body.skillMd, capabilities: body.capabilities },
    restCtx(c),
  );
  return c.json(skill);
});

skillsRouter.delete("/:handle", async (c) => {
  const memexId = requireWriteMemexId(c);
  await archiveSkill(memexId, c.req.param("handle"), restCtx(c));
  return c.body(null, 204);
});

export { skillsRouter };
