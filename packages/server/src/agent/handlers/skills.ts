// spec-300 t-4 — the three Skills MCP tools: list_skills, get_skill, and the
// verb-dispatched update_skill{create|edit|delete}. These are a THIN adapter over
// the pre-built Skills SERVICE (services/skills/skills-service.ts, t-10). They
// resolve tenancy + shape the tool response; they DO NOT re-implement any skill
// lifecycle logic.
//
// Tenancy (std-7 / dec-15): every tool resolves the caller's Memex through
// `ctx.resolveMemex`, which applies the read gate and — because a write tool
// carries `readOnlyHint: false` — the WRITE gate too (a non-member / cross-Memex
// caller surfaces the std-7 "not found" answer; a read-only member on a public
// Memex is rejected from update_skill). Skill refs are the canonical
// `<namespace>/<memex>/skills/skill-N` grammar; we parse them locally (the shared
// ref parser has no `skills` doc-type) and hand the `skill-N` handle to the
// service, which does its own memex-scoped, active-only lookup.
//
// dec-6 / tool-economy: the whole write surface is ONE verb-dispatched tool
// (update_skill) rather than three top-level create/edit/delete tools.

import { z } from "zod";
import { ValidationError } from "../../types/errors.js";
import {
  createSkill,
  editSkill,
  archiveSkill,
  getSkill,
  getSkillFile,
  listSkills,
  type SkillFileInput,
} from "../../services/skills/skills-service.js";
import type { SkillCapabilities } from "../../services/skills/skill-capabilities.js";
import { parseSkillMd } from "../../services/skills/parse-skill-md.js";
import { MEMEX_DESC, VERBOSE_FIELD, reqCtx, type ToolSpec } from "./shared.js";

// ── Local helpers ─────────────────────────────────────────────────────────────

const SLUG_RE = /^[a-z][a-z0-9-]*$/;
const SKILL_HANDLE_RE = /^skill-[1-9][0-9]*$/;

/** Parse a canonical Skill ref `<namespace>/<memex>/skills/skill-N` into its
 *  parts. Raw UUIDs are rejected at the MCP boundary (b-36 invariant) — only the
 *  canonical form is accepted. Throws ValidationError on any malformed input. */
function parseSkillRef(ref: unknown): {
  namespace: string;
  memex: string;
  handle: string;
} {
  if (typeof ref !== "string" || ref.length === 0) {
    throw new ValidationError(
      "A skill ref is required, e.g. `<namespace>/<memex>/skills/skill-1`.",
    );
  }
  const parts = ref.split("/");
  if (parts.length !== 4 || parts[2] !== "skills") {
    throw new ValidationError(
      `Invalid skill ref "${ref}" — expected \`<namespace>/<memex>/skills/skill-N\`.`,
    );
  }
  const [namespace, memex, , handle] = parts;
  if (!SLUG_RE.test(namespace) || !SLUG_RE.test(memex)) {
    throw new ValidationError(
      `Invalid skill ref "${ref}" — malformed namespace/memex slug.`,
    );
  }
  if (!SKILL_HANDLE_RE.test(handle)) {
    throw new ValidationError(
      `Invalid skill handle "${handle}" — expected \`skill-N\`; raw UUIDs are not accepted at the MCP boundary.`,
    );
  }
  return { namespace, memex, handle };
}

/** Render a capability flag-set as a compact, human-readable list of the enabled
 *  flags (or "none"). Never leaks the SKILL.md `allowed-tools` field (dec-10). */
function renderCapabilities(caps: SkillCapabilities): string {
  const on = Object.entries(caps)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  return on.length > 0 ? on.join(", ") : "none";
}

/** Render the auxiliary-file table-of-contents: path + type + size + purpose per
 *  entry, NEVER inline contents (ac-15). Single-line literals only. */
function renderFileToc(
  files: readonly { path: string; contentType: string; size: number; purpose: string | null }[],
): string {
  if (files.length === 0) return "\n\nAuxiliary files: none.";
  const lines = files.map((f) => {
    const purpose = f.purpose ? ` — ${f.purpose}` : "";
    return `- ${f.path} [${f.contentType}, ${f.size} bytes]${purpose}`;
  });
  return `\n\nAuxiliary files (${files.length}):\n` + lines.join("\n");
}

/** Shared capability-flag input shape (dec-20). Mirrors the service's normaliser
 *  — every flag optional; omitted flags default to false server-side. */
const CAPABILITIES_FIELD = z
  .object({
    codebaseAccess: z
      .boolean()
      .optional()
      .describe("The Skill expects to read the codebase."),
    codeEditing: z
      .boolean()
      .optional()
      .describe("The Skill expects to edit code."),
    externalTools: z
      .boolean()
      .optional()
      .describe("The Skill expects to reach external tools/services."),
  })
  .optional()
  .describe(
    "Memex-native capability flags describing what the Skill expects to touch. " +
      "Advisory routing metadata, not a security boundary. Omitted flags default to false.",
  );

/** One auxiliary-file input. Text files carry their bytes inline via `text`;
 *  binary files carry base64 via `dataBase64` (+ a `contentType`). */
const FILE_FIELD = z
  .array(
    z.object({
      path: z
        .string()
        .describe("Relative path of the file within the Skill bundle (e.g. templates/index.html)."),
      purpose: z
        .string()
        .optional()
        .describe("Short human note on what the file is for."),
      contentType: z
        .string()
        .optional()
        .describe("MIME type; required for binary (dataBase64) files, defaults to text/plain for text."),
      text: z
        .string()
        .optional()
        .describe("Inline UTF-8 text content — use for text files."),
      dataBase64: z
        .string()
        .optional()
        .describe("Base64-encoded bytes — use for binary files (also set contentType)."),
    }),
  )
  .optional()
  .describe("Auxiliary files bundled with the Skill. Optional.");

/** Map a tool-level file input into the service's SkillFileInput union. A file
 *  with `dataBase64` is binary (bytes → blob store); otherwise it is inline text. */
function toSkillFileInput(f: {
  path: string;
  purpose?: string;
  contentType?: string;
  text?: string;
  dataBase64?: string;
}): SkillFileInput {
  if (f.dataBase64 !== undefined) {
    return {
      path: f.path,
      purpose: f.purpose,
      contentType: f.contentType ?? "application/octet-stream",
      bytes: new Uint8Array(Buffer.from(f.dataBase64, "base64")),
    };
  }
  return {
    path: f.path,
    purpose: f.purpose,
    contentType: f.contentType,
    text: f.text ?? "",
  };
}

// ── The tools ─────────────────────────────────────────────────────────────────

export const skillsTools: ToolSpec[] = [
  {
    name: "list_skills",
    annotations: { title: "List Skills", readOnlyHint: true, destructiveHint: false },
    description:
      "List a Memex's ACTIVE Skills, alphabetical by name. Each entry carries name, description, capability flags, and its canonical ref — NOT the SKILL.md body, NOT auxiliary-file contents, NOT allowed-tools. Call get_skill to load a chosen Skill's body and file table-of-contents.",
    schema: {
      memex: z.string().optional().describe(MEMEX_DESC),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const memexId = await ctx.resolveMemex(input.memex as string | undefined);
      const skills = await listSkills(memexId);
      if (skills.length === 0) {
        return "No skills in this Memex yet.";
      }
      const lines = skills.map((s) => {
        const caps = renderCapabilities(s.capabilities);
        return `- ${s.name} — ${s.description} | capabilities: ${caps} | ref: ${s.ref}`;
      });
      return `Skills (${skills.length}):\n` + lines.join("\n");
    },
  },
  {
    name: "get_skill",
    annotations: { title: "Get Skill", readOnlyHint: true, destructiveHint: false },
    description:
      "Read one Skill. Default: the verbatim SKILL.md body plus a table-of-contents of its auxiliary files (path, type, size, purpose) — never inline file contents. Pass path to fetch ONE auxiliary file: binary files return a short-lived signed read URL, inline text files return the text. working_spec_ref is accepted for usage metering.",
    schema: {
      ref: z
        .string()
        .describe("Canonical Skill ref, e.g. `<namespace>/<memex>/skills/skill-1`."),
      working_spec_ref: z
        .string()
        .optional()
        .describe("Optional Spec ref this read is being done in service of — recorded for usage metering."),
      path: z
        .string()
        .optional()
        .describe("Auxiliary file path to fetch; omit to read the SKILL.md body + file TOC."),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const { namespace, memex, handle } = parseSkillRef(input.ref);
      const memexId = await ctx.resolveMemex(`${namespace}/${memex}`);
      // working_spec_ref threads through to the service's metering hook (consumed
      // by a later task); accepted here so the tool contract is stable.
      const workingSpecRef = input.working_spec_ref as string | undefined;
      void workingSpecRef;

      const path = input.path as string | undefined;
      if (path !== undefined) {
        const access = await getSkillFile(memexId, handle, path);
        if (access.kind === "inline") {
          return `Inline auxiliary file ${path} (${access.contentType}):\n\n${access.text}`;
        }
        return `ref: ${namespace}/${memex}/skills/${handle}\nSigned read URL for ${path} (${access.contentType}, short-lived):\n${access.url}`;
      }

      const view = await getSkill(memexId, handle);
      const header = `ref: ${view.ref}\ncapabilities: ${renderCapabilities(view.capabilities)}`;
      return header + "\n\n" + view.skillMd + renderFileToc(view.files);
    },
  },
  {
    name: "update_skill",
    annotations: { title: "Update Skill", readOnlyHint: false, destructiveHint: false },
    description:
      "Create, edit, or delete a Skill (verb one of create, edit, delete) — the path a coding agent uses to import a corpus of SKILL.md files into a Memex. create: supply memex + skill_md (+ optional capabilities, files); edit: supply ref + skill_md and/or capabilities; delete: supply ref (soft-archive). Every path runs the same server-side SKILL.md validation.",
    schema: {
      verb: z
        .enum(["create", "edit", "delete"])
        .describe("create | edit | delete — the skill write operation."),
      memex: z.string().optional().describe(MEMEX_DESC),
      ref: z
        .string()
        .optional()
        .describe("Canonical Skill ref for edit/delete, e.g. `<namespace>/<memex>/skills/skill-1`."),
      skill_md: z
        .string()
        .optional()
        .describe("Full SKILL.md text — required for create, optional for edit. Parsed + validated server-side."),
      capabilities: CAPABILITIES_FIELD,
      files: FILE_FIELD,
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const verb = input.verb as "create" | "edit" | "delete";

      if (verb === "create") {
        const skillMd = input.skill_md as string | undefined;
        if (!skillMd) {
          throw new ValidationError("update_skill(create) requires `skill_md`.");
        }
        const memexId = await ctx.resolveMemex(input.memex as string | undefined);

        // ac-36: reject a create whose SKILL.md name collides with an existing
        // ACTIVE skill in the same Memex, with a user-visible error. (Name is
        // extracted via the shared t-3 parser; malformed SKILL.md falls through
        // to createSkill's own validation, which raises the field-specific error.)
        let parsedName: string | undefined;
        try {
          parsedName = parseSkillMd(skillMd).name;
        } catch {
          parsedName = undefined;
        }
        if (parsedName) {
          const existing = await listSkills(memexId);
          const clash = existing.find(
            (s) => s.name.toLowerCase() === parsedName!.toLowerCase(),
          );
          if (clash) {
            throw new ValidationError(
              `A skill named "${parsedName}" already exists in this Memex (${clash.ref}). ` +
                `Pick a different name, or edit the existing skill.`,
            );
          }
        }

        const files = (input.files as
          | Parameters<typeof toSkillFileInput>[0][]
          | undefined)?.map(toSkillFileInput);
        const created = await createSkill(
          memexId,
          {
            skillMd,
            capabilities: input.capabilities,
            ...(files ? { files } : {}),
          },
          reqCtx(ctx),
        );
        const fileNote =
          created.files.length > 0 ? ` with ${created.files.length} auxiliary file(s)` : "";
        return `ref: ${created.ref}\nCreated skill "${created.name}" (${created.handle})${fileNote}.`;
      }

      if (verb === "edit") {
        const { namespace, memex, handle } = parseSkillRef(input.ref);
        const memexId = await ctx.resolveMemex(`${namespace}/${memex}`);
        const skillMd = input.skill_md as string | undefined;
        if (skillMd === undefined && input.capabilities === undefined) {
          throw new ValidationError(
            "update_skill(edit) requires `skill_md` and/or `capabilities`.",
          );
        }
        const updated = await editSkill(
          memexId,
          handle,
          {
            ...(skillMd !== undefined ? { skillMd } : {}),
            ...(input.capabilities !== undefined
              ? { capabilities: input.capabilities }
              : {}),
          },
          reqCtx(ctx),
        );
        return `ref: ${updated.ref}\nUpdated skill "${updated.name}" (${updated.handle}).`;
      }

      // verb === "delete"
      const { namespace, memex, handle } = parseSkillRef(input.ref);
      const memexId = await ctx.resolveMemex(`${namespace}/${memex}`);
      await archiveSkill(memexId, handle, reqCtx(ctx));
      return `ref: ${namespace}/${memex}/skills/${handle}\nDeleted skill ${handle}.`;
    },
  },
];
