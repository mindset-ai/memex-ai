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
  restoreSkill,
  getSkill,
  getSkillFile,
  listSkills,
  listSkillsForMemexes,
  type SkillFileInput,
  type SkillListItem,
  type MemexSkillGroup,
} from "../../services/skills/skills-service.js";
import type { SkillCapabilities } from "../../services/skills/skill-capabilities.js";
import { MEMEX_DESC, VERBOSE_FIELD, reqCtx, type ToolSpec } from "./tool-contract.js";

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

/** One skill's list line: name — description | capabilities | ref. Shared by the
 *  single-Memex and cross-Memex (`all_memexes`) renderers so both read identically. */
function renderSkillLine(s: SkillListItem): string {
  return `- ${s.name} — ${s.description} | capabilities: ${renderCapabilities(s.capabilities)} | ref: ${s.ref}`;
}

/** Render the cross-Memex union (`all_memexes:true`, spec-300 dec-25 / ac-64):
 *  one section per Memex that HAS skills, each skill carrying its full ref, plus a
 *  collision banner naming any skill whose name appears in more than one Memex so
 *  the agent knows to ASK the user rather than guess (ac-63). Empty Memexes are
 *  omitted from the body but still counted in the "searched N Memexes" summary. */
function renderAllMemexesSkills(groups: readonly MemexSkillGroup[]): string {
  if (groups.length === 0) {
    return "You are not a member of any Memex, so there are no Skills to list.";
  }
  const withSkills = groups.filter((g) => g.skills.length > 0);
  const total = withSkills.reduce((n, g) => n + g.skills.length, 0);
  if (total === 0) {
    return `No Skills found across your ${groups.length} Memex(es).`;
  }

  // Collisions: a lower-cased skill name present in more than one Memex.
  const memexesByName = new Map<string, Set<string>>();
  for (const g of withSkills) {
    for (const s of g.skills) {
      const key = s.name.toLowerCase();
      const set = memexesByName.get(key) ?? new Set<string>();
      set.add(g.memexRef);
      memexesByName.set(key, set);
    }
  }
  const collisions = withSkills
    .flatMap((g) => g.skills.map((s) => s.name))
    .filter((name, i, all) => all.indexOf(name) === i) // de-dupe display names
    .filter((name) => (memexesByName.get(name.toLowerCase())?.size ?? 0) > 1);

  const sections = withSkills.map(
    (g) =>
      `## ${g.memexName} (${g.memexRef}) — ${g.skills.length} skill(s)\n` +
      g.skills.map(renderSkillLine).join("\n"),
  );

  const header = `Skills across ${withSkills.length} of your ${groups.length} Memex(es), ${total} total:`;
  const collisionBanner =
    collisions.length > 0
      ? `\n\n⚠ Name collision across Memexes: ${collisions.join(", ")}. ` +
        `Ask the user which Memex's skill to use — do not guess.`
      : "";
  return header + collisionBanner + "\n\n" + sections.join("\n\n");
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
      "List ACTIVE Skills, alphabetical by name. Each entry carries name, description, capability flags, and its canonical ref — NOT the SKILL.md body, NOT auxiliary-file contents, NOT allowed-tools. Call get_skill to load a chosen Skill's body and file table-of-contents. When the user names a skill WITHOUT saying which Memex it lives in, pass all_memexes:true to find it across every Memex you can access, then get_skill by the returned ref; if the same name turns up in more than one Memex, ASK the user which one — never guess.",
    schema: {
      memex: z.string().optional().describe(MEMEX_DESC),
      all_memexes: z
        .boolean()
        .optional()
        .describe(
          "Set true to list your Skills across EVERY Memex you can access, grouped by Memex, each entry carrying its full ref — the way to locate a skill named without a Memex. Ignores `memex`. On a name that appears in more than one Memex, ASK the user which to use; never guess. Default false: single-Memex behaviour (the one-Memex default, or a disambiguation error when you belong to several).",
        ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      // spec-300 dec-25 / ac-64: cross-Memex union. Explicit opt-in (std-5 — no
      // silent cross-Memex default); enumerate exactly the Memexes the caller may
      // read (std-4, resolved by the ctx layer) and group skills one bucket per Memex.
      if (input.all_memexes === true) {
        // Both real surfaces bind the enumerator; only hand-rolled ctxes omit it.
        if (!ctx.listAccessibleMemexes) {
          throw new ValidationError("all_memexes is not supported in this context.");
        }
        return renderAllMemexesSkills(
          await listSkillsForMemexes(await ctx.listAccessibleMemexes()),
        );
      }

      const memexId = await ctx.resolveMemex(input.memex as string | undefined);
      const skills = await listSkills(memexId);
      if (skills.length === 0) {
        return "No skills in this Memex yet.";
      }
      return `Skills (${skills.length}):\n` + skills.map(renderSkillLine).join("\n");
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
      const workingSpecRef = input.working_spec_ref as string | undefined;

      const path = input.path as string | undefined;
      if (path !== undefined) {
        // A single-file fetch is not a Skill BODY fetch — it emits no usage event
        // (dec-21: the body read is the intent-to-use signal, not a file peek).
        const access = await getSkillFile(memexId, handle, path);
        if (access.kind === "inline") {
          return `Inline auxiliary file ${path} (${access.contentType}):\n\n${access.text}`;
        }
        return `ref: ${namespace}/${memex}/skills/${handle}\nSigned read URL for ${path} (${access.contentType}, short-lived):\n${access.url}`;
      }

      // Body fetch → the service records one `skill.used` event carrying the
      // working-Spec ref + the actor + channel:'mcp' (from reqCtx) (dec-21).
      const view = await getSkill(
        memexId,
        handle,
        reqCtx(ctx),
        workingSpecRef !== undefined ? { workingSpecRef } : {},
      );
      const header = `ref: ${view.ref}\ncapabilities: ${renderCapabilities(view.capabilities)}`;
      return header + "\n\n" + view.skillMd + renderFileToc(view.files);
    },
  },
  {
    name: "update_skill",
    annotations: { title: "Update Skill", readOnlyHint: false, destructiveHint: false },
    description:
      "Create, edit, delete, or restore a Skill (verb one of create, edit, delete, restore) — the path a coding agent uses to import a corpus of SKILL.md files into a Memex. create: supply memex + skill_md (+ optional capabilities, files); edit: supply ref + any of skill_md, capabilities, files (add or REPLACE an auxiliary file at the same path), remove_files (paths to drop); delete: supply ref (soft-archive, non-destructive); restore: supply ref (un-archive a soft-deleted skill). Every path runs the same server-side SKILL.md validation.",
    schema: {
      verb: z
        .enum(["create", "edit", "delete", "restore"])
        .describe("create | edit | delete | restore — the skill write operation."),
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
      remove_files: z
        .array(z.string())
        .optional()
        .describe(
          "On edit: auxiliary-file paths to REMOVE from the skill (blob + manifest row). Removing an absent path is a no-op.",
        ),
      verbose: VERBOSE_FIELD,
    },
    async handler(input, ctx) {
      const verb = input.verb as "create" | "edit" | "delete" | "restore";

      if (verb === "create") {
        const skillMd = input.skill_md as string | undefined;
        if (!skillMd) {
          throw new ValidationError("update_skill(create) requires `skill_md`.");
        }
        const memexId = await ctx.resolveMemex(input.memex as string | undefined);

        // ac-36 / dec-14: duplicate-name rejection is enforced in the SERVICE's
        // createSkill (the single source for REST, UI, and MCP) — no MCP-local
        // guard. A clash surfaces as the service's user-visible ValidationError.
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
        const files = (input.files as
          | Parameters<typeof toSkillFileInput>[0][]
          | undefined)?.map(toSkillFileInput);
        const removeFiles = input.remove_files as string[] | undefined;
        if (
          skillMd === undefined &&
          input.capabilities === undefined &&
          !files &&
          !removeFiles
        ) {
          throw new ValidationError(
            "update_skill(edit) requires at least one of `skill_md`, `capabilities`, `files`, `remove_files`.",
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
            ...(files ? { files } : {}),
            ...(removeFiles ? { removeFiles } : {}),
          },
          reqCtx(ctx),
        );
        return `ref: ${updated.ref}\nUpdated skill "${updated.name}" (${updated.handle}).`;
      }

      if (verb === "restore") {
        const { namespace, memex, handle } = parseSkillRef(input.ref);
        const memexId = await ctx.resolveMemex(`${namespace}/${memex}`);
        await restoreSkill(memexId, handle, reqCtx(ctx));
        return `ref: ${namespace}/${memex}/skills/${handle}\nRestored skill ${handle}.`;
      }

      // verb === "delete"
      const { namespace, memex, handle } = parseSkillRef(input.ref);
      const memexId = await ctx.resolveMemex(`${namespace}/${memex}`);
      await archiveSkill(memexId, handle, reqCtx(ctx));
      return `ref: ${namespace}/${memex}/skills/${handle}\nDeleted skill ${handle}.`;
    },
  },
];
