// Audit-style probes against the canonical tool catalogue.
//
// These aren't "happy path" coverage — they're targeted hypotheses about
// where contract drift between description text, runtime behaviour, and
// dependent surfaces is most likely to lurk. Pass = invariant codified;
// fail = real bug found.
//
// Probes:
//   1. Migration-map replacements all reference real tools.
//   2. MEMEX_AGENT_INSTRUCTIONS string references real tools (no stale docs
//      pointing at cut names).
//   3. Tool descriptions claiming a default value → spec applies that default.
//   4. Argument-coupling rules in tool descriptions are enforced at runtime.
//   5. zod enum tightness — invalid status values are rejected, not silently
//      stored.
//   6. search_standards.limit boundary — description / schema says max 50; the
//      schema must reject 100.
//   7. toolSpecs catalog count matches the file header comment.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/connection.js";
import {
  memexes,
  namespaces,
  documents,
  decisions,
  tasks,
  docSections,
  docComments,
  users,
  acs,
  issues,
} from "../db/schema.js";
import { makeTestMemex } from "../services/test-helpers.js";
import { createDocDraft } from "../services/documents.js";
import { createStandard } from "../services/standards.js";
import { createIssue } from "../services/issues.js";
import { addSection } from "../services/sections.js";
import { addComment } from "../services/comments.js";
import { ValidationError } from "../types/errors.js";
import { toolSpecs, type ToolCtx } from "./tool-specs.js";
import {
  getToolDefinitions,
  getCreationToolDefinitions,
  isUiTool,
  executeServerTool,
} from "./tools.js";
import { MIGRATION_MAP } from "../mcp/migration-map.js";
import { createMcpServer } from "../mcp/tools.js";

const cleanup = { memexes: [] as string[], docs: [] as string[], users: [] as string[] };

afterAll(async () => {
  if (cleanup.memexes.length) {
    await db.delete(docComments).where(inArray(docComments.memexId, cleanup.memexes)).catch(() => {});
  }
  if (cleanup.docs.length) {
    await db.delete(tasks).where(inArray(tasks.docId, cleanup.docs)).catch(() => {});
    await db.delete(decisions).where(inArray(decisions.docId, cleanup.docs)).catch(() => {});
    await db.delete(docSections).where(inArray(docSections.docId, cleanup.docs)).catch(() => {});
    await db.delete(documents).where(inArray(documents.id, cleanup.docs)).catch(() => {});
  }
  for (const id of cleanup.memexes) {
    await db.delete(memexes).where(eq(memexes.id, id)).catch(() => {});
  }
  for (const id of cleanup.users) {
    await db.delete(users).where(eq(users.id, id)).catch(() => {});
  }
});

async function makeUser(prefix: string): Promise<string> {
  const [u] = await db
    .insert(users)
    .values({ email: `audit-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@memex.ai` } as any)
    .returning();
  cleanup.users.push(u.id);
  return u.id;
}

function liveMcpToolNames(): Set<string> {
  const server = createMcpServer("00000000-0000-0000-0000-0000000000ff");
  return new Set(
    Object.keys(
      (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
    ),
  );
}

function liveAgentToolNames(): Set<string> {
  return new Set(getToolDefinitions().map((t) => t.name));
}

function specByName(name: string) {
  const spec = toolSpecs.find((s) => s.name === name);
  if (!spec) throw new Error(`Spec not found: ${name}`);
  return spec;
}

function ctxFor(memexId: string, userId: string): ToolCtx {
  return {
    userId,
    resolveMemexFromEntity: async () => memexId,
    resolveMemex: async () => memexId,
    resolveRef: async () => {
      throw new Error("resolveRef not stubbed in this test fixture");
    },
    workspaceUrl: async () => "https://test.example",
    verbose: false,
  };
}

// b-36 T-6: tests that need to call ref-accepting tools (single `ref` arg
// pointing into a real memex) build the ctx with a real resolver behind the
// `resolveRef` hook. Mirrors `buildAgentCtx` in agent/tools.ts.
async function slugsFor(memexId: string): Promise<{ namespace: string; memex: string }> {
  const m = await db.query.memexes.findFirst({ where: eq(memexes.id, memexId) });
  if (!m) throw new Error(`memex ${memexId} not found`);
  const ns = await db.query.namespaces.findFirst({
    where: eq(namespaces.id, m.namespaceId),
  });
  if (!ns) throw new Error(`namespace for memex ${memexId} not found`);
  return { namespace: ns.slug, memex: m.slug };
}

function ctxForWithResolver(memexId: string, userId: string): ToolCtx {
  return {
    userId,
    resolveMemexFromEntity: async () => memexId,
    resolveMemex: async () => memexId,
    resolveRef: async (ref: string) => {
      const { parseRef } = await import("../services/refs.js");
      const { resolveRef: resolveCanonicalRef } = await import("../services/resolver.js");
      const { ValidationError, NotFoundError } = await import("../types/errors.js");
      const parsed = parseRef(ref);
      if (!parsed.ok) throw new ValidationError(`Invalid ref "${ref}": ${parsed.reason}`);
      const result = await resolveCanonicalRef(parsed.ref);
      if ("redirected" in result) {
        throw new ValidationError(
          `Ref redirected: "${ref}" now lives at "${result.newRef}". Retry with the new ref.`,
        );
      }
      if ("notFound" in result) {
        throw new NotFoundError(`Ref "${ref}" not found (${result.reason})`);
      }
      const entity = result.entity;
      const doc = "doc" in entity ? entity.doc : entity.row;
      if (doc.memexId !== memexId) {
        throw new NotFoundError(`Ref "${ref}" not found.`);
      }
      return {
        entity,
        memexId: doc.memexId,
        doc,
        slugs: { namespace: parsed.ref.namespace, memex: parsed.ref.memex },
      };
    },
    workspaceUrl: async () => "https://test.example",
    verbose: false,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Probe 1: migration-map replacements → real tools
// ──────────────────────────────────────────────────────────────────────────

// SKIP: doc-24 — migration-map has entries pointing at hidden tools (list_symbols, get_symbol, search_standards, etc.). Restore alongside the tools.
describe.skip("audit: migration-map replacement tools all exist", () => {
  it("every MIGRATION_MAP[old].replacement is a currently-registered MCP/agent tool", () => {
    const mcp = liveMcpToolNames();
    const agent = liveAgentToolNames();
    const all = new Set([...mcp, ...agent]);
    const dangling: Array<{ old: string; replacement: string }> = [];
    for (const [oldName, entry] of Object.entries(MIGRATION_MAP)) {
      if (!all.has(entry.replacement)) {
        dangling.push({ old: oldName, replacement: entry.replacement });
      }
    }
    expect(dangling, dangling.length === 0
      ? ""
      : `migration-map points at tools that don't exist anymore. ` +
        `When a replacement is renamed/cut, update migration-map.ts:\n` +
        dangling.map((d) => `  - ${d.old} → ${d.replacement} (missing)`).join("\n"),
    ).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Probe 2: MEMEX_AGENT_INSTRUCTIONS references real tools
// ──────────────────────────────────────────────────────────────────────────
//
// The instructions string lives in mcp/tools.ts and is sent to MCP clients
// as the `instructions` field on McpServer construction. It mentions specific
// tool names — those must resolve, otherwise the instructions point at cut
// or renamed tools and the agent gets bad advice.

describe("audit: McpServer instructions reference real tools", () => {
  it("every backtick-quoted tool name in the instructions resolves", () => {
    // Re-extract the instructions text by reading it from a freshly-built server.
    // We can't import the constant directly (it's not exported) but the McpServer
    // exposes it via construction; reading the source as a string is robust enough
    // here for an audit-level check.
    // Use a regex over the source file content.
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const src = fs.readFileSync(
      path.resolve(__dirname, "../mcp/tools.ts"),
      "utf8",
    );
    const startIdx = src.indexOf("MEMEX_AGENT_INSTRUCTIONS = `");
    expect(startIdx).toBeGreaterThan(-1);
    const endIdx = src.indexOf("`;", startIdx);
    const instructions = src.slice(startIdx, endIdx);

    // Find every `tool_name(...)` or `tool_name` reference inside the
    // instructions. We're conservative: only call out names that look like
    // tool names (snake_case, no parens-stripping).
    const toolPattern = /`([a-z_][a-z0-9_]*)(?:\(|`)/g;
    const referenced = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = toolPattern.exec(instructions)) !== null) {
      const candidate = m[1];
      // Ignore obvious non-tool tokens.
      if (
        candidate === "draft" ||
        candidate === "specify" ||
        candidate === "build" ||
        candidate === "verify" ||
        candidate === "done" ||
        candidate === "paused" ||
        candidate === "archived" ||
        candidate === "complete" ||
        candidate === "memex" ||
        candidate === "question" ||
        candidate === "type"
      ) continue;
      referenced.add(candidate);
    }

    const all = new Set([...liveMcpToolNames(), ...liveAgentToolNames()]);
    const dangling = [...referenced].filter((name) => !all.has(name));
    expect(dangling, dangling.length === 0
      ? ""
      : `MEMEX_AGENT_INSTRUCTIONS references tool names that don't exist as registered tools. ` +
        `Either fix the instructions text or stop quoting these names with backticks:\n  - ${dangling.join("\n  - ")}`,
    ).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Probe 3: tool description claims a default → spec applies it
// ──────────────────────────────────────────────────────────────────────────

describe("audit: declared defaults match runtime behaviour", () => {
  let memexId: string;
  let userId: string;

  beforeAll(async () => {
    memexId = await makeTestMemex("audit-defaults");
    cleanup.memexes.push(memexId);
    userId = await makeUser("defaults");
  });

  it("create_doc with no docType defaults to 'spec' (matches the description)", async () => {
    // The create_doc tool description says docType "Defaults to 'spec'".
    const spec = specByName("create_doc");
    const out = await spec.handler(
      { title: "Default-docType audit", purpose: "p" },
      ctxFor(memexId, userId),
    );
    // Find the doc that was created and confirm docType.
    const doc = await db.query.documents.findFirst({
      where: eq(documents.title, "Default-docType audit"),
    });
    expect(doc).toBeDefined();
    if (doc) cleanup.docs.push(doc.id);
    expect(doc!.docType, `terse output was: ${out}`).toBe("spec");
  });

  it("publish_spec with no status defaults to 'specify'", async () => {
    // publish_spec description: "Defaults to specify status."
    const doc = await createDocDraft(memexId, "Publish-default audit", "p", "spec");
    cleanup.docs.push(doc.id);
    const slugs = await slugsFor(memexId);
    const spec = specByName("publish_spec");
    await spec.handler(
      { ref: `${slugs.namespace}/${slugs.memex}/specs/${doc.handle}` },
      ctxForWithResolver(memexId, userId),
    );
    const fresh = await db.query.documents.findFirst({ where: eq(documents.id, doc.id) });
    expect(fresh!.status).toBe("specify");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Probe 4: argument-coupling rules are enforced
// ──────────────────────────────────────────────────────────────────────────

describe("audit: argument-coupling enforcement at handler level", () => {
  let memexId: string;
  let docId: string;
  let sectionId: string;
  const userId = "00000000-0000-0000-0000-0000000000c2";

  beforeAll(async () => {
    memexId = await makeTestMemex("audit-coupling");
    cleanup.memexes.push(memexId);
    const doc = await createDocDraft(memexId, "Coupling audit", "p", "spec");
    docId = doc.id;
    cleanup.docs.push(doc.id);
    const sec = await addSection(memexId, doc.id, "design", "x");
    sectionId = sec.id;
  });

  it("add_comment refuses zero targets", async () => {
    const spec = specByName("add_comment");
    await expect(
      spec.handler(
        { authorName: "tester", content: "zero-target attempt" },
        ctxFor(memexId, userId),
      ),
    ).rejects.toThrow(ValidationError);
  });

  it("add_comment refuses two targets", async () => {
    const spec = specByName("add_comment");
    await expect(
      spec.handler(
        {
          sectionId,
          decisionId: "00000000-0000-0000-0000-000000000aaa",
          authorName: "tester",
          content: "two-target attempt",
        },
        ctxFor(memexId, userId),
      ),
    ).rejects.toThrow(ValidationError);
  });

  it("list_comments refuses zero of {sectionId,decisionId,taskId,docId}", async () => {
    const spec = specByName("list_comments");
    await expect(
      spec.handler({}, ctxFor(memexId, userId)),
    ).rejects.toThrow(ValidationError);
  });

  it("list_comments refuses two of {sectionId,decisionId,taskId,docId}", async () => {
    const spec = specByName("list_comments");
    await expect(
      spec.handler({ sectionId, docId }, ctxFor(memexId, userId)),
    ).rejects.toThrow(ValidationError);
  });

  // SKIP: doc-24 — code_search hidden; restore alongside the tool.
  it.skip("code_search with no phrase/phrases/keywords surfaces a warning or error", async () => {
    // No phrase, no phrases, no keywords — there's nothing to search. The
    // tool should refuse rather than silently return zero results, since the
    // user has no signal whether it was a "no matches" or "you forgot to
    // pass any of the inputs" outcome.
    const spec = specByName("code_search");
    let threw = false;
    let result = "";
    try {
      result = await spec.handler(
        { repoRef: "any" },
        ctxFor(memexId, userId),
      );
    } catch {
      threw = true;
    }
    if (!threw) {
      // If it didn't throw, the result must at least carry a warning that
      // names the missing inputs — silent zero-results would be a bug.
      expect(result.toLowerCase(), `code_search returned silently with no inputs: ${result}`)
        .toMatch(/warning|provide|require|empty|no (phrase|keyword)/i);
    }
    // Either branch is acceptable; the test fails only on silent success
    // with no signal.
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Probe 5: zod enum tightness
// ──────────────────────────────────────────────────────────────────────────

describe("audit: zod enum tightness", () => {
  it("update_doc.status rejects values outside the declared enum", () => {
    const spec = specByName("update_doc");
    const obj = z.object(spec.schema);
    const bad = obj.safeParse({ docId: "x", status: "invented-status" });
    expect(bad.success, `update_doc accepted an unknown status string`).toBe(false);
  });

  it("create_decision.status rejects values outside ['open', 'candidate']", () => {
    const spec = specByName("create_decision");
    const obj = z.object(spec.schema);
    const bad = obj.safeParse({
      docId: "x",
      title: "y",
      status: "deferred",
    });
    expect(bad.success).toBe(false);
  });

  it("assess_spec.mode rejects unknown modes", () => {
    const spec = specByName("assess_spec");
    const obj = z.object(spec.schema);
    const bad = obj.safeParse({ missionId: "x", mode: "freshness" });
    expect(bad.success).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Probe 6: search_memex.limit boundary (b-34 — was search_standards.limit
// pre-rename; same schema rule, applied to the new spec).
// ──────────────────────────────────────────────────────────────────────────

describe("audit: numeric bounds on schema fields", () => {
  it("search_memex.limit rejects values above the documented max (50)", () => {
    const spec = specByName("search_memex");
    const obj = z.object(spec.schema);
    const bad = obj.safeParse({ query: "x", limit: 100 });
    expect(bad.success, `search_memex accepted limit=100 — schema's max(50) constraint is missing or wrong`)
      .toBe(false);
  });

  it("search_memex.limit accepts values inside the band", () => {
    const spec = specByName("search_memex");
    const obj = z.object(spec.schema);
    expect(obj.safeParse({ query: "x", limit: 25 }).success).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Probe 7: catalog count consistency
// ──────────────────────────────────────────────────────────────────────────

describe("audit: catalog count consistency", () => {
  // SKIP: doc-24 — 10 tools commented out (7 codebase + 3 standards); count will not match 30 until tools are restored.
  it.skip("toolSpecs export length matches the count claimed in the file header", () => {
    // The file header in tool-specs.ts states "30 specs" (the shared surface).
    // Verify the export.
    expect(toolSpecs.length).toBe(30);
  });

  it("MCP-only tools is exactly {list_memexes}", () => {
    const mcp = liveMcpToolNames();
    const agent = liveAgentToolNames();
    const mcpOnly = [...mcp].filter((n) => !agent.has(n));
    expect(mcpOnly.sort()).toEqual(["list_memexes"]);
  });

  it("agent-only tools is exactly the 6 render_* UI tools", () => {
    const mcp = liveMcpToolNames();
    const agentTools = getToolDefinitions();
    const agentOnly = agentTools.filter((t) => !mcp.has(t.name) && isUiTool(t.name)).map((t) => t.name);
    const expected = [
      "render_action_buttons",
      "render_choices",
      "render_confirmation",
      "render_progress",
      "render_callout",
      "render_steps",
    ].sort();
    expect(agentOnly.sort()).toEqual(expected);
    // Agent must not have any non-UI tools missing from MCP.
    const agentNonUiOnly = agentTools.filter((t) => !mcp.has(t.name) && !isUiTool(t.name)).map((t) => t.name);
    expect(agentNonUiOnly).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Probe 8: tool description "Replaces X" claims match the migration map
// ──────────────────────────────────────────────────────────────────────────
//
// Many tool descriptions say "Replaces list_missions, list_standards" etc.
// Each such name must (a) be in MIGRATION_MAP (i.e. genuinely cut) and
// (b) currently absent from both registered surfaces (i.e. cut for real,
// not still half-active). A description that claims a replacement for a
// tool still in service is a lie.

describe("audit: 'Replaces X' description claims align with migration-map", () => {
  it("every name in a 'Replaces X, Y, Z' clause is in MIGRATION_MAP and absent from registries", () => {
    const liveAll = new Set([...liveMcpToolNames(), ...liveAgentToolNames()]);
    const issues: string[] = [];
    const replacesPattern = /[Rr]eplaces?\s+([a-z_][a-z0-9_,\s/]+)\./g;

    for (const spec of toolSpecs) {
      let m: RegExpExecArray | null;
      while ((m = replacesPattern.exec(spec.description)) !== null) {
        const claim = m[1];
        // Split on commas / whitespace / slashes; trim; drop empties.
        const names = claim
          .split(/[,\s/]+/)
          .map((s) => s.trim())
          .filter((s) => /^[a-z_][a-z0-9_]*$/.test(s));
        for (const name of names) {
          if (!(name in MIGRATION_MAP)) {
            issues.push(`${spec.name} claims to replace '${name}' but it's not in MIGRATION_MAP`);
          }
          if (liveAll.has(name)) {
            issues.push(`${spec.name} claims to replace '${name}' but '${name}' is still a live registered tool`);
          }
        }
      }
    }
    expect(issues, issues.length === 0
      ? ""
      : `tool descriptions reference tools they don't actually replace:\n  - ${issues.join("\n  - ")}`,
    ).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Probe 9: backtick-quoted field names in tool descriptions match schema
// ──────────────────────────────────────────────────────────────────────────
//
// When a tool description says "pass `linkedTaskId`", that field must
// actually exist in the spec's schema. Drift here means LLM-readable docs
// point at fields the runtime can't accept.

describe("audit: field names referenced in descriptions exist in the schema", () => {
  // Words inside backticks that look like schema fields (camelCase or
  // snake_case identifiers, not tool names with parens). Filter against
  // a small allowlist of common false positives.
  const FALSE_POSITIVES = new Set([
    // Status enum values (claimed in descriptions, not schema fields)
    "draft", "specify", "build", "verify", "done", "open", "candidate",
    "resolved", "rejected", "deleted", "not_started", "in_progress", "complete", "discussion",
    "question", "drift", "plan_revision", "progress", "review",
    "task_notes", "default", "phase", "narrative", "comments",
    "consolidate", "endpoint",
    // Markdown formatting tokens (spec-138: the discord description lists
    // `code` among the Markdown styles Discord renders — not a schema field)
    "code",
    // Doc types
    "spec", "standard", "document", "execution_plan",
    // Other tool names referenced cross-tool (we test those separately)
    "list_docs", "get_doc", "create_doc", "update_doc",
    "create_decision", "resolve_decision", "update_decision", "delete_decision",
    "list_decisions",
    "create_task", "update_task", "delete_task", "list_tasks",
    "add_section", "update_section",
    "add_comment", "list_comments", "update_comment",
    "list_memexes", "search_memex", "flag_drift", "propose_standard_change",
    "assess_spec", "publish_spec",
    "list_repos", "get_repo", "update_repo",
    "list_symbols", "get_symbol", "get_file", "code_search",
    "approve_candidate", "reject_candidate",
    // Comment-type helpers / aliases
    "cross_reference", "readiness_check", "approval", "issue", "deferred",
    // Issue status / type enum values + cross-referenced Issue tool names
    // (spec-112) — claimed in descriptions, not schema fields.
    "wont_fix", "converted", "bug", "todo",
    "register_issue", "list_issues", "get_issue", "update_issue",
    "resolve_issue", "search_issues",
    "convert_issue_to_task", "kick_task_to_issue",
    // AC primitive vocabulary — VerificationState enum values and the
    // test_events table name; legitimately referenced in AC-related tool
    // descriptions (list_acs, get_ac, etc.) to teach the agent the
    // verification-state vocabulary.
    "test_events", "verified", "failing", "stale", "untested",
    // spec-127 test-event vocabulary + tool names referenced in descriptions
    // (test_identifier is a schema field on discontinue/restore but a bare
    // domain term in get_test_matrix's description; the tool names cross-
    // reference each other).
    "test_identifier", "get_test_matrix", "discontinue_test_events", "restore_test_events",
    // Other commonly-quoted miscellany
    "memex", "type", "true", "false", "null", "options", "now",
    "RRF", "FTS",
    // Decision-row column referenced in update_decision description for the
    // restore mode (b-97). Not a schema input field — it lives on the row.
    "previousStatus",
  ]);

  it("every backticked field reference in a description is in that tool's schema", () => {
    const fieldRefRe = /`([a-z_][a-zA-Z0-9_]*)`/g;
    const issues: string[] = [];

    for (const spec of toolSpecs) {
      const schemaFields = new Set(Object.keys(spec.schema));
      let m: RegExpExecArray | null;
      while ((m = fieldRefRe.exec(spec.description)) !== null) {
        const name = m[1];
        if (FALSE_POSITIVES.has(name)) continue;
        // If it looks like an identifier *and* isn't in the schema and
        // isn't a known tool name / status, it's a candidate drift.
        if (!schemaFields.has(name)) {
          issues.push(`${spec.name}: description references \`${name}\` but no schema field of that name`);
        }
      }
    }
    expect(issues, issues.length === 0
      ? ""
      : `tool descriptions point at fields that don't exist in the schema:\n  - ${issues.join("\n  - ")}`,
    ).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Probe 10: getCreationToolDefinitions surface
// ──────────────────────────────────────────────────────────────────────────
//
// spec-230 t-1 (supersedes spec-5/dec-1): the creation phase NO LONGER limits
// the surface to {create_doc, add_section, search_memex}. To reach web ↔ MCP
// parity, the in-app creation agent now gets the full spec-authoring surface —
// sections, decisions, AND acceptance criteria — so a substantial input fleshes
// out into a rich, multi-section Spec instead of a thin Overview. The set is
// single-sourced from the @memex/shared manifest (std-16): manifest
// `group: 'planning'` OR `trafficClass: 'specify'`, plus the read tools
// (search_memex, get_doc) and the render_* UI tools.
//
// The one hard exclusion that must NOT drift back in: build-phase task verbs
// (create_task / update_task / delete_task) — the creation agent authors a
// Spec's plan, it does not run the build. Exhaustive membership + manifest-
// derivation are pinned in tools.creation-parity.test.ts; this probe guards the
// load-bearing inclusions and the task-verb exclusion.

describe("audit: creation-phase surface reaches MCP spec-authoring parity", () => {
  it("getCreationToolDefinitions exposes section + decision + AC authoring, never build-phase task verbs", () => {
    const names = getCreationToolDefinitions().map((t) => t.name);
    // Spec-authoring surface present (sections, decisions, ACs).
    for (const t of [
      "create_doc",
      "add_section",
      "update_section",
      "create_decision",
      "resolve_decision",
      "create_ac",
      "link_ac_to_decision",
      "search_memex",
      "get_doc",
    ]) {
      expect(names).toContain(t);
    }
    // The render_confirmation mutation gate (and the rest of the render_* UI
    // family) ride along.
    expect(names).toContain("render_confirmation");
    // Build-phase task verbs stay OUT — the modal authors a plan, not a build.
    expect(names).not.toContain("create_task");
    expect(names).not.toContain("update_task");
    expect(names).not.toContain("delete_task");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Probe 11: Spec-phase vocabulary agrees across tools
// ──────────────────────────────────────────────────────────────────────────
//
// `update_doc.status`, `publish_spec.status`, and `assess_spec.target`
// all gate forward Spec moves. If they ever disagree on the canonical
// phase vocabulary, an LLM-emitted call that worked on one tool fails on
// another with a confusing zod error.

describe("audit: Spec-phase vocabulary is consistent across tools", () => {
  function enumValues(spec: ReturnType<typeof specByName>, field: string): string[] | null {
    // The spec.schema is a ZodRawShape — keys map to zod schemas. Pull the
    // enum values via the public API where available.
    const fieldSchema = spec.schema[field] as unknown;
    if (!fieldSchema) return null;
    const obj = z.object({ [field]: fieldSchema as z.ZodTypeAny });
    const json = z.toJSONSchema(obj) as unknown as {
      properties?: Record<string, { enum?: string[] }>;
    };
    return json.properties?.[field]?.enum ?? null;
  }

  it("publish_spec.status and assess_spec.target use the same forward-phase set", () => {
    const publishStatus = enumValues(specByName("publish_spec"), "status");
    const assessTarget = enumValues(specByName("assess_spec"), "target");
    expect(publishStatus, "publish_spec.status enum is missing").not.toBeNull();
    expect(assessTarget, "assess_spec.target enum is missing").not.toBeNull();
    // Forward phase vocabulary: specify / build / verify / done.
    const expected = ["specify", "build", "verify", "done"].sort();
    expect((publishStatus ?? []).sort()).toEqual(expected);
    expect((assessTarget ?? []).sort()).toEqual(expected);
  });

  it("update_doc.status accepts every forward phase publish_spec accepts", () => {
    const publishStatus = new Set(enumValues(specByName("publish_spec"), "status") ?? []);
    const docStatus = new Set(enumValues(specByName("update_doc"), "status") ?? []);
    const missing = [...publishStatus].filter((s) => !docStatus.has(s));
    expect(missing, missing.length === 0
      ? ""
      : `update_doc.status must accept every status publish_spec can produce; ` +
        `missing: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Probe A (doc-20 t-10, refreshed for b-36): terse output emits `ref:`,
// never a raw UUID.
// ──────────────────────────────────────────────────────────────────────────
//
// Pre-b-36 every terse mutation/list response had to include the affected
// entity's UUID. b-36 D-2/D-7/D-8 reversed that — refs are the public
// identifier; UUIDs at the tool boundary are a hard error. This probe now
// asserts the inverse: terse output contains a `ref:` line and no raw UUID.
//
// SKIP list rationale lives next to each entry. A tool legitimately belongs
// in SKIP only when its terse output names no affected entity (e.g.
// "No standards matched ...") or when the fixture would need an ingested
// repo + symbol graph that this suite doesn't seed.

const REF_PROBE_SKIP = new Map<string, string>([
  // SKIP: doc-24 — entries below reference tools commented out (codebase + standards). Restore alongside the tools.
  // ["search_standards", "no-match returns 'No standards matched ...' with no entity"],
  // ["code_search", "no-match returns 'No matches.'"],
  // ["get_file", "returns the file source as the payload, not entity confirmation"],
  // ["list_repos", "requires ingested repos; exercised in repo-ingestion suite"],
  // ["get_repo", "requires an ingested repo; exercised in repo-ingestion suite"],
  // ["list_symbols", "requires an ingested repo; exercised separately"],
  // ["get_symbol", "requires an ingested repo; exercised separately"],
  // ["update_repo", "returns admin ack on the domain alias, not a repo confirmation"],
  // assess_spec returns analysis text (rubric / freshness / comments
  // survey / consolidation stamp), not a per-entity confirmation in the
  // dec-1 sense. Tested separately via the verbose path and by the
  // per-mode pins.
  ["assess_spec", "returns analysis text keyed on handle, not a per-entity UUID confirmation"],
  // search_memex (b-34) is a discovery tool, not entity-acting — its output is a
  // ranked hit list with canonical URL paths as headings (no `ref:` lines per
  // hit and no per-call entity confirmation). Audited in ref-emission.regression
  // SKIPS for the same reason.
  ["search_memex", "discovery tool — output is a ranked hit list (paths as headings), no per-entity confirmation"],
  // search_issues (spec-112) is a thin scoped wrapper over search_memex(kind:'issue')
  // — same ranked-hit-list output (paths as headings), no per-entity `ref:` confirmation.
  ["search_issues", "discovery tool — scoped search_memex wrapper; output is a ranked hit list (paths as headings), no per-entity confirmation"],
  // memex__send_slack_message sends to an external system; terse output is
  // `sent: ts=... channel=...` — no memex entity ref. Requires a live Slack
  // token — cannot be exercised in the integration suite.
  ["memex__send_slack_message", "external-action tool — output confirms delivery (ts/channel), not a memex entity ref; requires live Slack token"],
  // memex__send_discord_message (spec-138) is the same shape: delivery to an
  // external system via the org's webhook — no memex entity ref in the output,
  // and a live webhook URL would be required to exercise it here.
  ["memex__send_discord_message", "external-action tool — output confirms webhook delivery, not a memex entity ref; requires live Discord webhook"],
  // get_information returns prose (topic index or topic body), never an entity ref.
  ["get_information", "Read-only guidance tool — returns markdown prose, not a memex entity ref"],
  // get_prompt (spec-263) returns the composed handoff prompt (or a no-handoff
  // explanation) — prompt prose interpolated from slugs/handles, never a UUID.
  // Output asserted byte-for-byte in agent/get-prompt.spec-263.integration.
  ["get_prompt", "Read-only prompt tool — returns handoff prompt prose, not a memex entity ref; covered by get-prompt.spec-263.integration"],
  // provision_ac_emission (spec-234) returns a raw emission key + integration guidance
  // markdown, not a terse `ref:` entity confirmation. Exercised end-to-end in
  // agent/spec-234-provision-ac-emission.integration.
  ["provision_ac_emission", "returns an emission key + guidance markdown, not a memex entity ref; covered by spec-234-provision-ac-emission.integration"],
  // spec-127 test-event tools all lead with the AC `ref:` and emit no UUID; that
  // ref-emission is asserted directly in mcp/test-event-tools.integration. A
  // dedicated probe here would need a throwaway AC + seeded test_events fixture.
  ["get_test_matrix", "emits the AC ref:; covered by mcp/test-event-tools.integration"],
  ["discontinue_test_events", "emits the AC ref:; covered by mcp/test-event-tools.integration"],
  ["restore_test_events", "emits the AC ref:; covered by mcp/test-event-tools.integration"],
  // export_doc (spec-100) returns a lossless full-document markdown export (every
  // comment thread expanded inline), not a per-entity confirmation — the terse
  // ref:/no-UUID invariant doesn't apply. Exercised in doc-export.integration.
  ["export_doc", "lossless full-document markdown export, not a per-entity confirmation; covered by doc-export.integration"],
  // spec-161 clause tools emit the clause `cl-N` ref (standards only). A dedicated
  // integration probe would need a throwaway standard + section + clause fixture; the
  // terse cl-N response (and the standards-only cross-redirects) are asserted directly
  // in tools.test.ts (ac-11) for all three.
  ["add_clause", "emits clause cl-N ref (standards only); cl-N response asserted in tools.test.ts (spec-161 ac-11)"],
  ["edit_clause", "emits clause cl-N ref (standards only); cl-N response asserted in tools.test.ts (spec-161 ac-11)"],
  ["delete_clause", "soft-delete — emits clause cl-N ref (standards only); cl-N response asserted in tools.test.ts (spec-161 ac-11)"],
  // flag_drift / propose_standard_change are PROBED below (b-36 D-8): since the
  // ref-emission fix they return the canonical `ref:` of the drift/plan_revision
  // comment instead of raw section/comment UUIDs.
]);

describe("audit: b-36 D-8 — every terse mutation/list response emits `ref:` and no raw UUID", () => {
  let memexId: string;
  let userId: string;
  let slugs: { namespace: string; memex: string };
  let docHandle: string;
  let docInDraftHandle: string;
  let sectionSeq: number;
  let deleteSectionSeq: number;
  let openDecisionSeq: number;
  let candidateDecisionSeq1: number;
  let candidateDecisionSeq2: number;
  let resolvedDecisionSeq: number;
  let deleteDecisionSeq: number;
  let taskSeq1: number;
  let taskSeq2: number;
  let commentSeq: number;
  let acSeqForGet: number;
  let acSeqForUpdate: number;
  let acSeqForDelete: number;
  let acSeqForLink: number;
  // Issues (spec-112): one each for get/update/resolve probes.
  let issueSeqForGet: number;
  let issueSeqForUpdate: number;
  let issueSeqForResolve: number;
  // spec-112 t-6: an open issue for convert_issue_to_task, a task for kick.
  let issueSeqForConvert: number;
  let taskSeqForKick: number;
  let memexIdForUpdate: string;
  let slugsForUpdate: { namespace: string; memex: string };
  let docHandleForUpdate: string;
  // Standard fixtures (spec-143 dec-1): flag_drift + propose_standard_change
  // act on a standard SECTION (raw UUID input — no handle scheme), and emit a
  // `ref:` to the comment that lands under the standard's std-N handle.
  let driftSectionRef: string;
  let proposeSectionRef: string;

  beforeAll(async () => {
    memexId = await makeTestMemex("probe-ref");
    cleanup.memexes.push(memexId);
    slugs = await slugsFor(memexId);
    userId = await makeUser("probe-ref");
    // Spec in build (for create_task, list_tasks, etc.).
    const doc = await createDocDraft(memexId, "Probe Doc", "x", "spec");
    docHandle = doc.handle;
    cleanup.docs.push(doc.id);
    await db
      .update(documents)
      .set({ status: "build", statusChangedAt: new Date() })
      .where(eq(documents.id, doc.id));
    const sec = await addSection(memexId, doc.id, "design", "body");
    sectionSeq = sec.seq;
    // Dedicated throwaway section for the delete_section probe (spec-107).
    // Created last so it holds the highest seq — deleting it resequences no
    // other section, keeping sectionSeq stable for the other section probes.
    const delSec = await addSection(memexId, doc.id, "to-delete", "body");
    deleteSectionSeq = delSec.seq;

    // Spec still in draft (for publish_spec).
    const draft = await createDocDraft(memexId, "Draft Doc", "x", "spec");
    docInDraftHandle = draft.handle;
    cleanup.docs.push(draft.id);

    // Open decision for resolve_decision; resolved decision for
    // update_decision (reopen); two candidate decisions for approve /
    // reject (each consumes one).
    const [openDec] = await db
      .insert(decisions)
      .values({ memexId, docId: doc.id, seq: 100, title: "Open Q" } as never)
      .returning();
    openDecisionSeq = openDec.seq;
    const [resolvedDec] = await db
      .insert(decisions)
      .values({
        memexId,
        docId: doc.id,
        seq: 101,
        title: "Resolved Q",
        status: "resolved",
        resolution: "answered",
      } as never)
      .returning();
    resolvedDecisionSeq = resolvedDec.seq;
    const [cand1] = await db
      .insert(decisions)
      .values({ memexId, docId: doc.id, seq: 102, title: "Cand Q1", status: "candidate" } as never)
      .returning();
    candidateDecisionSeq1 = cand1.seq;
    const [cand2] = await db
      .insert(decisions)
      .values({ memexId, docId: doc.id, seq: 103, title: "Cand Q2", status: "candidate" } as never)
      .returning();
    candidateDecisionSeq2 = cand2.seq;
    // Open decision dedicated to the delete_decision probe (b-97).
    const [delDec] = await db
      .insert(decisions)
      .values({ memexId, docId: doc.id, seq: 104, title: "To delete" } as never)
      .returning();
    deleteDecisionSeq = delDec.seq;

    // Two tasks: one for update_task, one for delete_task.
    const [t1] = await db
      .insert(tasks)
      .values({ memexId, docId: doc.id, seq: 100, title: "Probe T1", description: "x" } as never)
      .returning();
    taskSeq1 = t1.seq;
    const [t2] = await db
      .insert(tasks)
      .values({ memexId, docId: doc.id, seq: 101, title: "Probe T2", description: "x" } as never)
      .returning();
    taskSeq2 = t2.seq;

    // Comment for update_comment + list_comments (so list_comments returns
    // at least one line).
    const c = await addComment(memexId, sec.id, "tester", "Probe comment", {
      type: "discussion",
    });
    commentSeq = c.seq;

    // Four ACs for get/update/delete/link probes. Each test gets a fresh row
    // so the destructive cases don't break the read-only ones.
    const [ac1] = await db
      .insert(acs)
      .values({ memexId, briefId: doc.id, seq: 1, kind: "scope", statement: "probe get_ac" } as never)
      .returning();
    acSeqForGet = ac1.seq;
    const [ac2] = await db
      .insert(acs)
      .values({ memexId, briefId: doc.id, seq: 2, kind: "scope", statement: "probe update_ac" } as never)
      .returning();
    acSeqForUpdate = ac2.seq;
    const [ac3] = await db
      .insert(acs)
      .values({ memexId, briefId: doc.id, seq: 3, kind: "scope", statement: "probe delete_ac" } as never)
      .returning();
    acSeqForDelete = ac3.seq;
    const [ac4] = await db
      .insert(acs)
      .values({ memexId, briefId: doc.id, seq: 4, kind: "implementation", statement: "probe link_ac" } as never)
      .returning();
    acSeqForLink = ac4.seq;

    // Three Issues on the build Spec for the get/update/resolve probes
    // (spec-112). createIssue mints `issue-N` independent of the ac/task/etc. seq
    // spaces, so we read each seq back rather than assuming a value.
    const iGet = await createIssue({ memexId, docId: doc.id, title: "Probe issue get", body: "x", type: "bug" });
    issueSeqForGet = iGet.seq;
    const iUpd = await createIssue({ memexId, docId: doc.id, title: "Probe issue update", body: "x", type: "bug" });
    issueSeqForUpdate = iUpd.seq;
    const iRes = await createIssue({ memexId, docId: doc.id, title: "Probe issue resolve", body: "x", type: "todo" });
    issueSeqForResolve = iRes.seq;
    // An open issue for the convert_issue_to_task probe (down-bridge → fresh Task ref).
    const iConv = await createIssue({ memexId, docId: doc.id, title: "Probe issue convert", body: "x", type: "bug" });
    issueSeqForConvert = iConv.seq;
    // A standalone task for the kick_task_to_issue probe (up-bridge → fresh Issue ref).
    const [tKick] = await db
      .insert(tasks)
      .values({ memexId, docId: doc.id, seq: 102, title: "Probe kick task", description: "x" } as never)
      .returning();
    taskSeqForKick = tKick.seq;

    // Separate memex for the update_doc probe — its memex-scoped doc.
    memexIdForUpdate = await makeTestMemex("probe-ref-upd");
    cleanup.memexes.push(memexIdForUpdate);
    slugsForUpdate = await slugsFor(memexIdForUpdate);
    const dUpd = await createDocDraft(memexIdForUpdate, "Update Doc", "x", "spec");
    docHandleForUpdate = dUpd.handle;
    cleanup.docs.push(dUpd.id);

    // Standard with two sections — one each for the flag_drift and
    // propose_standard_change probes (each posts a comment; isolating them
    // keeps the per-section comment seq deterministic). Created in the same
    // memex as the default probe ctx so resolveMemexFromEntity resolves.
    const std = await createStandard(memexId, {
      title: "Probe Standard",
      sections: [
        { sectionType: "rule-drift", content: "Original rule body for drift probe." },
        { sectionType: "rule-propose", content: "Original rule body for propose probe." },
      ],
    });
    cleanup.docs.push(std.id);
    // spec-143 ac-14: drift verbs take the canonical section ref, not a UUID.
    const stdBase = `${slugs.namespace}/${slugs.memex}/standards/${std.handle}`;
    driftSectionRef = `${stdBase}/sections/s-${std.sections.find((s) => s.sectionType === "rule-drift")!.seq}`;
    proposeSectionRef = `${stdBase}/sections/s-${std.sections.find((s) => s.sectionType === "rule-propose")!.seq}`;
  });

  type ProbeCase = {
    input: () => Record<string, unknown>;
    memexId?: string;
  };

  function docRef(s: { namespace: string; memex: string }, h: string): string {
    return `${s.namespace}/${s.memex}/specs/${h}`;
  }
  function childRef(
    s: { namespace: string; memex: string },
    h: string,
    type: "sections" | "decisions" | "tasks" | "comments" | "acs" | "issues",
    seq: number,
  ): string {
    const p =
      type === "sections" ? "s" :
      type === "decisions" ? "dec" :
      type === "tasks" ? "t" :
      type === "comments" ? "c" :
      type === "issues" ? "issue" :
      "ac";
    return `${s.namespace}/${s.memex}/specs/${h}/${type}/${p}-${seq}`;
  }

  function casesAfterSetup(): Map<string, ProbeCase> {
    return new Map<string, ProbeCase>([
      ["list_docs", { input: () => ({ memex: `${slugs.namespace}/${slugs.memex}` }) }],
      ["get_doc", { input: () => ({ ref: docRef(slugs, docHandle) }) }],
      [
        "create_doc",
        {
          input: () => ({
            memex: `${slugs.namespace}/${slugs.memex}`,
            title: "Probe Doc Inner",
            purpose: "probe body",
            docType: "spec",
          }),
        },
      ],
      [
        "update_doc",
        {
          input: () => ({
            ref: docRef(slugsForUpdate, docHandleForUpdate),
            title: "Renamed for probe",
          }),
          memexId: memexIdForUpdate,
        },
      ],
      [
        "add_section",
        {
          input: () => ({
            ref: docRef(slugs, docHandle),
            sectionType: `probe-section-${Math.random().toString(36).slice(2, 8)}`,
            content: "body",
          }),
        },
      ],
      [
        // spec-260: appends a versioned qa_report section; the terse response
        // carries the new section's child ref.
        "write_qa_report",
        {
          input: () => ({
            ref: docRef(slugs, docHandle),
            content: "Probe QA report body.",
          }),
        },
      ],
      [
        "update_section",
        {
          input: () => ({
            ref: childRef(slugs, docHandle, "sections", sectionSeq),
            content: "new body for probe",
          }),
        },
      ],
      [
        "retitle_section",
        {
          // Title-only retitle keeps seq/sectionType stable.
          input: () => ({
            ref: childRef(slugs, docHandle, "sections", sectionSeq),
            title: "Probe Retitled",
          }),
        },
      ],
      [
        "delete_section",
        {
          input: () => ({
            ref: childRef(slugs, docHandle, "sections", deleteSectionSeq),
          }),
        },
      ],
      [
        "create_decision",
        { input: () => ({ ref: docRef(slugs, docHandle), title: "Probe Q" }) },
      ],
      [
        "update_decision",
        {
          input: () => ({
            ref: childRef(slugs, docHandle, "decisions", resolvedDecisionSeq),
            status: "open",
          }),
        },
      ],
      [
        "delete_decision",
        {
          input: () => ({
            ref: childRef(slugs, docHandle, "decisions", deleteDecisionSeq),
          }),
        },
      ],
      [
        "resolve_decision",
        {
          input: () => ({
            ref: childRef(slugs, docHandle, "decisions", openDecisionSeq),
            resolution: "Probe answer.",
          }),
        },
      ],
      [
        "approve_candidate",
        {
          input: () => ({
            ref: childRef(slugs, docHandle, "decisions", candidateDecisionSeq1),
          }),
        },
      ],
      [
        "reject_candidate",
        {
          input: () => ({
            ref: childRef(slugs, docHandle, "decisions", candidateDecisionSeq2),
            reason: "probe-reject",
          }),
        },
      ],
      ["list_tasks", { input: () => ({ ref: docRef(slugs, docHandle) }) }],
      [
        "create_task",
        {
          input: () => ({
            ref: docRef(slugs, docHandle),
            title: "Probe new task",
            description: "x",
          }),
        },
      ],
      [
        "update_task",
        {
          input: () => ({
            ref: childRef(slugs, docHandle, "tasks", taskSeq1),
            status: "in_progress",
          }),
        },
      ],
      [
        "delete_task",
        { input: () => ({ ref: childRef(slugs, docHandle, "tasks", taskSeq2) }) },
      ],
      [
        "add_comment",
        {
          input: () => ({
            ref: childRef(slugs, docHandle, "sections", sectionSeq),
            authorName: "probe",
            content: "probe comment body",
          }),
        },
      ],
      [
        "list_comments",
        { input: () => ({ ref: childRef(slugs, docHandle, "sections", sectionSeq) }) },
      ],
      [
        "update_comment",
        {
          input: () => ({
            ref: childRef(slugs, docHandle, "comments", commentSeq),
            status: "resolved",
          }),
        },
      ],
      [
        "publish_spec",
        { input: () => ({ ref: docRef(slugs, docInDraftHandle) }) },
      ],
      [
        "create_ac",
        {
          input: () => ({
            ref: docRef(slugs, docHandle),
            kind: "scope",
            statement: "probe create_ac",
          }),
        },
      ],
      [
        "list_acs",
        { input: () => ({ ref: docRef(slugs, docHandle) }) },
      ],
      [
        "get_ac",
        { input: () => ({ ref: childRef(slugs, docHandle, "acs", acSeqForGet) }) },
      ],
      [
        "update_ac",
        {
          input: () => ({
            ref: childRef(slugs, docHandle, "acs", acSeqForUpdate),
            statement: "probe update_ac (updated)",
          }),
        },
      ],
      [
        "delete_ac",
        { input: () => ({ ref: childRef(slugs, docHandle, "acs", acSeqForDelete) }) },
      ],
      [
        "link_ac_to_decision",
        {
          input: () => ({
            ac_ref: childRef(slugs, docHandle, "acs", acSeqForLink),
            decision_ref: childRef(slugs, docHandle, "decisions", openDecisionSeq),
          }),
        },
      ],
      // ── Issues (spec-112) ──
      [
        "register_issue",
        {
          input: () => ({
            spec_ref: docRef(slugs, docHandle),
            title: "Probe registered issue",
            body: "probe body",
            type: "bug",
          }),
        },
      ],
      ["list_issues", { input: () => ({ ref: docRef(slugs, docHandle) }) }],
      [
        "get_issue",
        { input: () => ({ ref: childRef(slugs, docHandle, "issues", issueSeqForGet) }) },
      ],
      [
        "update_issue",
        {
          input: () => ({
            ref: childRef(slugs, docHandle, "issues", issueSeqForUpdate),
            severity: "high",
          }),
        },
      ],
      [
        "resolve_issue",
        {
          input: () => ({
            ref: childRef(slugs, docHandle, "issues", issueSeqForResolve),
            resolution: "wont_fix",
          }),
        },
      ],
      [
        "convert_issue_to_task",
        {
          input: () => ({
            ref: childRef(slugs, docHandle, "issues", issueSeqForConvert),
          }),
        },
      ],
      [
        "kick_task_to_issue",
        {
          input: () => ({
            ref: childRef(slugs, docHandle, "tasks", taskSeqForKick),
            reason: "needs offline DNS change",
          }),
        },
      ],
      // ── Per-Spec roles + assignment (spec-118) ──
      ["get_spec_roles", { input: () => ({ ref: docRef(slugs, docHandle) }) }],
      [
        "set_spec_role",
        { input: () => ({ ref: docRef(slugs, docHandle), user: userId, role: "editor" }) },
      ],
      ["assign_spec", { input: () => ({ ref: docRef(slugs, docHandle), user: userId }) }],
      ["unassign_spec", { input: () => ({ ref: docRef(slugs, docHandle), user: userId }) }],
      // ── Standards drift tools (spec-143 dec-1, ac-14) ──
      // Both take a canonical standard-section `ref` and emit a `ref:` to the
      // comment that lands under the standard's std-N handle.
      [
        "flag_drift",
        {
          input: () => ({
            ref: driftSectionRef,
            observation: "Probe: the code no longer matches this rule.",
          }),
        },
      ],
      [
        "propose_standard_change",
        {
          input: () => ({
            ref: proposeSectionRef,
            proposedContent: "Probe: corrected rule body.",
            rationale: "probe rationale",
          }),
        },
      ],
    ]);
  }

  it("REF_PROBE_SKIP entries reference real specs", () => {
    const names = new Set(toolSpecs.map((s) => s.name));
    const stale = [...REF_PROBE_SKIP.keys()].filter((n) => !names.has(n));
    expect(stale, stale.length === 0 ? "" : `stale SKIP entries: ${stale.join(", ")}`).toEqual([]);
  });

  it("every non-skipped spec has a probe case registered (no silent gaps)", () => {
    const cases = casesAfterSetup();
    const missing: string[] = [];
    for (const spec of toolSpecs) {
      if (REF_PROBE_SKIP.has(spec.name)) continue;
      if (!cases.has(spec.name)) missing.push(spec.name);
    }
    expect(
      missing,
      missing.length === 0
        ? ""
        : `add either a case in casesAfterSetup() or a SKIP entry with justification for: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  // b-36 D-2 / D-7 / D-8: terse outputs lead with `ref:` and carry no raw
  // UUID. The pre-b-36 inverse — "must contain a UUID" — flipped here.
  it("every probe-registered terse output carries `ref:` and no raw UUID", async () => {
    const cases = casesAfterSetup();
    const failures: string[] = [];
    for (const [name, c] of cases) {
      const spec = specByName(name);
      try {
        const ctx = ctxForWithResolver(c.memexId ?? memexId, userId);
        const out = await spec.handler(c.input(), ctx);
        if (UUID_RE.test(out)) {
          failures.push(`${name}: terse output still contains a raw UUID — ${JSON.stringify(out.slice(0, 200))}`);
        }
        if (!out.includes("ref:")) {
          failures.push(`${name}: terse output missing 'ref:' substring — ${JSON.stringify(out.slice(0, 200))}`);
        }
      } catch (err) {
        failures.push(`${name}: handler threw — ${(err as Error).message}`);
      }
    }
    expect(failures, failures.length === 0 ? "" : failures.join("\n")).toEqual([]);
  });
});

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// ──────────────────────────────────────────────────────────────────────────
// Probe B (doc-20 t-10): VERBOSE_FIELD identity
// ──────────────────────────────────────────────────────────────────────────

describe("audit: every spec.schema.verbose references the shared VERBOSE_FIELD (doc-20 t-10)", () => {
  it("VERBOSE_FIELD is present on every spec by identity", async () => {
    const { VERBOSE_FIELD } = await import("./tool-specs.js");
    const offenders: string[] = [];
    for (const spec of toolSpecs) {
      const v = (spec.schema as Record<string, unknown>).verbose;
      if (v === undefined) {
        offenders.push(`${spec.name}: schema.verbose is missing`);
      } else if (v !== VERBOSE_FIELD) {
        offenders.push(`${spec.name}: schema.verbose is not the shared VERBOSE_FIELD instance`);
      }
    }
    expect(offenders, offenders.length === 0 ? "" : offenders.join("\n")).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Probe C (doc-20 t-10): standard-form *Id descriptions
// ──────────────────────────────────────────────────────────────────────────
//
// Per dec-3, every `*Id` parameter accepts UUID or handle. The schema
// description should communicate that — the "UUID or `<prefix>-N` handle"
// shape. This probe catches description drift after dec-3 lands. Pure
// schema parameters that legitimately stay UUID-only (no handle scheme:
// section UUIDs, comment UUIDs, standard-section UUIDs) are exempt.

const ID_PARAM_UUID_ONLY = new Set<string>([
  // Section / comment / standard-section UUIDs — no handle scheme today.
  "update_section.sectionId",
  "add_comment.sectionId",
  "list_comments.sectionId",
  "update_comment.commentId",
  // spec-143 ac-14: flag_drift / propose_standard_change no longer take a raw
  // section UUID — they take a canonical section `ref` resolved server-side
  // (resolveStandardSectionRef), so they are no longer listed here.
  // Cross-reference target id is opaque (depends on referenceType), not a
  // memex-scoped handle.
  "add_comment.referenceId",
  // Codebase-intelligence row IDs — symbol / file IDs are repo-scoped UUIDs
  // with no `<prefix>-N` handle scheme.
  "get_symbol.symbolId",
  "get_symbol.fileId",
  "get_file.fileId",
]);

describe("audit: every *Id schema field's description matches the dec-3 standard form (doc-20 t-10)", () => {
  it("each handle-accepting *Id description names the UUID-or-handle option", () => {
    const STANDARD_FORM_RE = /UUID or .*handle/i;
    const offenders: string[] = [];
    for (const spec of toolSpecs) {
      const shape = spec.schema as Record<string, unknown>;
      for (const [fieldName, fieldSchema] of Object.entries(shape)) {
        if (!fieldName.endsWith("Id")) continue;
        const path = `${spec.name}.${fieldName}`;
        if (ID_PARAM_UUID_ONLY.has(path)) continue;
        const desc = ((fieldSchema as { description?: string })?.description ?? "")
          .toString();
        if (!STANDARD_FORM_RE.test(desc)) {
          offenders.push(`${path}: description "${desc}" missing the "UUID or <prefix>-N handle" form`);
        }
      }
    }
    expect(offenders, offenders.length === 0 ? "" : offenders.join("\n")).toEqual([]);
  });
});

// Suppress unused-import warning
void executeServerTool;
