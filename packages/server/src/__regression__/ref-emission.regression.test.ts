// b-36 T-7: regression gate for D-8 — every entity-acting MCP tool's terse
// output leads with `ref:` and carries no raw UUID.
//
// Pre-b-36 outputs threaded `(uuid: <uuid>)` parentheticals through the terse
// path. D-2 / D-7 / D-8 reversed that: refs are the canonical identifier on
// the wire; UUIDs at the boundary are a hard error and never appear in
// formatted output.
//
// This file enumerates the catalogue and dispatches each entity-acting tool
// against a seeded fixture, asserting:
//   1. Response carries `ref:` somewhere (a canonical path the agent can
//      paste into the next tool call).
//   2. Response does NOT contain a UUID matching the canonical Postgres v4
//      pattern.
//
// Skips:
//   - `search_memex` (b-34 → b-36 T-8 audit): T-8 owns the audit; if the
//     tool isn't yet on the catalogue this regression silently no-ops on it.
//   - Codebase-intelligence tools (`list_repos`, `get_repo`, `update_repo`,
//     `list_symbols`, `get_symbol`, `get_file`, `code_search`): out of scope
//     per Architecture, currently commented out in tool-specs.ts.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
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
import { toolSpecs, type ToolCtx } from "../agent/tool-specs.js";
import { parseRef } from "../services/refs.js";
import { resolveRef as resolveCanonicalRef } from "../services/resolver.js";
import { ValidationError, NotFoundError } from "../types/errors.js";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const cleanup = {
  memexes: [] as string[],
  docs: [] as string[],
  users: [] as string[],
};

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

async function slugsFor(memexId: string): Promise<{ namespace: string; memex: string }> {
  const m = await db.query.memexes.findFirst({ where: eq(memexes.id, memexId) });
  if (!m) throw new Error(`memex ${memexId} not found`);
  const ns = await db.query.namespaces.findFirst({
    where: eq(namespaces.id, m.namespaceId),
  });
  if (!ns) throw new Error(`namespace for memex ${memexId} not found`);
  return { namespace: ns.slug, memex: m.slug };
}

function refForDoc(slugs: { namespace: string; memex: string }, h: string): string {
  return `${slugs.namespace}/${slugs.memex}/specs/${h}`;
}
function refForChild(
  slugs: { namespace: string; memex: string },
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
  return `${slugs.namespace}/${slugs.memex}/specs/${h}/${type}/${p}-${seq}`;
}

function ctxForMemex(memexId: string, userId: string): ToolCtx {
  return {
    userId,
    resolveMemexFromEntity: async () => memexId,
    resolveMemex: async () => memexId,
    resolveRef: async (ref: string) => {
      const parsed = parseRef(ref);
      if (!parsed.ok) throw new ValidationError(`Invalid ref "${ref}": ${parsed.reason}`);
      const result = await resolveCanonicalRef(parsed.ref);
      if ("redirected" in result) {
        throw new ValidationError(`Ref redirected: "${ref}" → "${result.newRef}".`);
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
    workspaceUrl: async () => "",
    verbose: false,
  };
}

// Tools that don't fit the ref-emission contract — terse output is analysis
// text or memex-list, not a per-entity confirmation. Each entry names the
// reason so a future restorer has the context.
const SKIPS = new Map<string, string>([
  // search_memex is the T-8 sister deliverable. It's a discovery tool whose
  // output mirrors list_memexes / list_docs; not an entity-acting tool, so
  // ref emission isn't required. Skip until T-8 confirms the shape.
  ["search_memex", "T-8 audit — search tool, not entity-acting"],
  // search_issues (spec-112) is a scoped search_memex wrapper — same ranked
  // hit-list output (paths as headings), not entity-acting, so no `ref:` line.
  ["search_issues", "scoped search_memex wrapper — search tool, not entity-acting"],
  // assess_spec emits the rubric + fact sheet keyed on the spec handle, not
  // a per-entity confirmation. Tested separately in spec-tools.integration.
  ["assess_spec", "analysis text keyed on the spec handle"],
  // list_memexes returns memex listings (no entity refs to emit per-row).
  ["list_memexes", "memex-list output, not entity-acting"],
  // send_slack_message returns { ts, channel } — a Slack delivery receipt, not an entity ref.
  ["memex__send_slack_message", "Slack delivery tool — returns ts/channel, not a memex entity ref"],
  // get_information returns prose (topic index or topic body), never an entity ref.
  ["get_information", "Read-only guidance tool — returns markdown prose, not a memex entity ref"],
  // export_doc (spec-100) returns a lossless full-document markdown export (every
  // comment thread expanded inline), not a terse per-entity confirmation — the
  // b-36 D-8 ref:/no-UUID terseness invariant doesn't apply. Exercised in
  // doc-export.integration.
  ["export_doc", "lossless full-document markdown export, not a terse entity confirmation; covered by doc-export.integration"],
  // delete_decision soft-deletes a decision and emits the decision ref — the
  // same ref-emission path as update_decision / resolve_decision, which ARE
  // probed here on the same entity type. A dedicated probe would need its own
  // throwaway decision (deleting one mutates shared fixtures); soft-delete
  // behaviour is exercised in decisions.integration (b-97).
  ["delete_decision", "soft-delete — decision-ref emission identical to update_decision (probed); covered by decisions.integration"],
  // delete_section soft-deletes a section and emits the section ref — the same
  // ref-emission path as update_section / retitle_section, which ARE probed here
  // on the same entity type. A dedicated probe would need its own throwaway
  // section (deleting one resequences shared fixtures); soft-delete + resequence
  // behaviour is exercised in sections.integration (spec-107).
  ["delete_section", "soft-delete — section-ref emission identical to update_section (probed); covered by sections.integration"],
  // spec-161 clause tools emit the clause `cl-N` ref (standards only); a dedicated
  // probe would need a throwaway standard + section + clause fixture. The ref-emission
  // path mirrors the section tools, and the terse cl-N response is asserted directly in
  // tools.test.ts (ac-11) for all three.
  ["add_clause", "emits clause cl-N ref (standards only); cl-N response asserted in tools.test.ts (spec-161 ac-11)"],
  ["edit_clause", "emits clause cl-N ref (standards only); cl-N response asserted in tools.test.ts (spec-161 ac-11)"],
  ["delete_clause", "soft-delete — emits clause cl-N ref (standards only); cl-N response asserted in tools.test.ts (spec-161 ac-11)"],
  // flag_drift / propose_standard_change are PROBED below (b-36 D-8): since the
  // ref-emission fix they return the canonical `ref:` of the drift/plan_revision
  // comment instead of raw section/comment UUIDs.
]);

interface ProbeCase {
  input: () => Record<string, unknown>;
}

describe("regression: every entity-acting MCP tool emits `ref:` and no raw UUID (b-36 D-8)", () => {
  let memexId: string;
  let userId: string;
  let slugs: { namespace: string; memex: string };
  let docHandle: string;
  let docId: string;
  let docInDraftHandle: string;
  let sectionSeq: number;
  let openDecSeq: number;
  let resolvedDecSeq: number;
  let candDecSeq1: number;
  let candDecSeq2: number;
  let taskSeq1: number;
  let taskSeq2: number;
  let commentSeq: number;
  let memexIdForUpd: string;
  let slugsForUpd: { namespace: string; memex: string };
  let docHandleForUpd: string;
  let acSeqForGet: number;
  let acSeqForUpdate: number;
  let acSeqForDelete: number;
  let acSeqForLink: number;
  // Issues (spec-112): get/update/resolve probes.
  let issueSeqForGet: number;
  let issueSeqForUpdate: number;
  let issueSeqForResolve: number;
  // Issues (spec-112 t-6): an open issue for convert_issue_to_task, and a task
  // for kick_task_to_issue — both produce a `ref:` line on a fresh entity.
  let issueSeqForConvert: number;
  let taskSeqForKick: number;
  // Standard fixtures (spec-143 dec-1): flag_drift + propose_standard_change
  // act on a standard SECTION (raw UUID input — no handle scheme) and emit a
  // `ref:` to the comment that lands under the standard's std-N handle.
  let driftSectionId: string;
  let proposeSectionId: string;

  beforeAll(async () => {
    memexId = await makeTestMemex("ref-emit");
    cleanup.memexes.push(memexId);
    slugs = await slugsFor(memexId);
    const [u] = await db
      .insert(users)
      .values({ email: `ref-emit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@memex.ai` } as never)
      .returning();
    cleanup.users.push(u.id);
    userId = u.id;

    // Spec in build (for task / list_tasks / etc.).
    const doc = await createDocDraft(memexId, "RefEmit Doc", "x", "spec");
    docHandle = doc.handle;
    docId = doc.id;
    cleanup.docs.push(doc.id);
    await db
      .update(documents)
      .set({ status: "build", statusChangedAt: new Date() })
      .where(eq(documents.id, doc.id));
    const sec = await addSection(memexId, doc.id, "design", "body");
    sectionSeq = sec.seq;

    // Draft spec for publish_spec.
    const draft = await createDocDraft(memexId, "RefEmit Draft", "x", "spec");
    docInDraftHandle = draft.handle;
    cleanup.docs.push(draft.id);

    // Decisions: open, resolved, two candidates.
    const [openDec] = await db
      .insert(decisions)
      .values({ memexId, docId, seq: 100, title: "Open Q" } as never)
      .returning();
    openDecSeq = openDec.seq;
    const [resolvedDec] = await db
      .insert(decisions)
      .values({
        memexId,
        docId,
        seq: 101,
        title: "Resolved Q",
        status: "resolved",
        resolution: "answered",
      } as never)
      .returning();
    resolvedDecSeq = resolvedDec.seq;
    const [c1] = await db
      .insert(decisions)
      .values({ memexId, docId, seq: 102, title: "Cand 1", status: "candidate" } as never)
      .returning();
    candDecSeq1 = c1.seq;
    const [c2] = await db
      .insert(decisions)
      .values({ memexId, docId, seq: 103, title: "Cand 2", status: "candidate" } as never)
      .returning();
    candDecSeq2 = c2.seq;

    // Two tasks.
    const [t1] = await db
      .insert(tasks)
      .values({ memexId, docId, seq: 100, title: "T1", description: "x" } as never)
      .returning();
    taskSeq1 = t1.seq;
    const [t2] = await db
      .insert(tasks)
      .values({ memexId, docId, seq: 101, title: "T2", description: "x" } as never)
      .returning();
    taskSeq2 = t2.seq;

    // Comment for update_comment + list_comments.
    const c = await addComment(memexId, sec.id, "tester", "Probe comment", {
      type: "discussion",
    });
    commentSeq = c.seq;

    // Four ACs for get/update/delete/link probes.
    const [ac1] = await db
      .insert(acs)
      .values({ memexId, briefId: docId, seq: 1, kind: "scope", statement: "probe get_ac" } as never)
      .returning();
    acSeqForGet = ac1.seq;
    const [ac2] = await db
      .insert(acs)
      .values({ memexId, briefId: docId, seq: 2, kind: "scope", statement: "probe update_ac" } as never)
      .returning();
    acSeqForUpdate = ac2.seq;
    const [ac3] = await db
      .insert(acs)
      .values({ memexId, briefId: docId, seq: 3, kind: "scope", statement: "probe delete_ac" } as never)
      .returning();
    acSeqForDelete = ac3.seq;
    const [ac4] = await db
      .insert(acs)
      .values({ memexId, briefId: docId, seq: 4, kind: "implementation", statement: "probe link_ac" } as never)
      .returning();
    acSeqForLink = ac4.seq;

    // Three Issues on the build Spec for get/update/resolve probes (spec-112).
    const iGet = await createIssue({ memexId, docId, title: "RefEmit issue get", body: "x", type: "bug" });
    issueSeqForGet = iGet.seq;
    const iUpd = await createIssue({ memexId, docId, title: "RefEmit issue update", body: "x", type: "bug" });
    issueSeqForUpdate = iUpd.seq;
    const iRes = await createIssue({ memexId, docId, title: "RefEmit issue resolve", body: "x", type: "todo" });
    issueSeqForResolve = iRes.seq;
    // An open issue for the convert probe (down-bridge → fresh Task ref).
    const iConv = await createIssue({ memexId, docId, title: "RefEmit issue convert", body: "x", type: "bug" });
    issueSeqForConvert = iConv.seq;
    // A standalone task for the kick probe (up-bridge → fresh Issue ref). seq 102
    // continues the manual task-seq sequence used by taskSeq1/taskSeq2 above.
    const [tKick] = await db
      .insert(tasks)
      .values({ memexId, docId, seq: 102, title: "RefEmit kick task", description: "x" } as never)
      .returning();
    taskSeqForKick = tKick.seq;

    // Separate memex for the update_doc probe.
    memexIdForUpd = await makeTestMemex("ref-emit-upd");
    cleanup.memexes.push(memexIdForUpd);
    slugsForUpd = await slugsFor(memexIdForUpd);
    const dUpd = await createDocDraft(memexIdForUpd, "Update Doc", "x", "spec");
    docHandleForUpd = dUpd.handle;
    cleanup.docs.push(dUpd.id);

    // Standard with two sections — one each for the flag_drift and
    // propose_standard_change probes. Same memex as the default probe ctx, so
    // resolveMemexFromEntity resolves.
    const std = await createStandard(memexId, {
      title: "RefEmit Standard",
      sections: [
        { sectionType: "rule-drift", content: "Original rule body for drift probe." },
        { sectionType: "rule-propose", content: "Original rule body for propose probe." },
      ],
    });
    cleanup.docs.push(std.id);
    driftSectionId = std.sections.find((s) => s.sectionType === "rule-drift")!.id;
    proposeSectionId = std.sections.find((s) => s.sectionType === "rule-propose")!.id;
  });

  // Build the per-tool case registry. One per shared spec that emits a
  // per-entity confirmation.
  function casesByName(): Map<string, ProbeCase & { memexId?: string }> {
    return new Map<string, ProbeCase & { memexId?: string }>([
      ["list_docs", { input: () => ({ memex: `${slugs.namespace}/${slugs.memex}` }) }],
      ["get_doc", { input: () => ({ ref: refForDoc(slugs, docHandle) }) }],
      [
        "create_doc",
        {
          input: () => ({
            memex: `${slugs.namespace}/${slugs.memex}`,
            title: "RefEmit Inner",
            purpose: "probe",
            docType: "spec",
          }),
        },
      ],
      [
        "update_doc",
        {
          input: () => ({
            ref: refForDoc(slugsForUpd, docHandleForUpd),
            title: "Renamed-for-ref-emit",
          }),
          memexId: memexIdForUpd,
        },
      ],
      [
        "add_section",
        {
          input: () => ({
            ref: refForDoc(slugs, docHandle),
            sectionType: `ref-emit-${Math.random().toString(36).slice(2, 8)}`,
            content: "body",
          }),
        },
      ],
      [
        "update_section",
        {
          input: () => ({
            ref: refForChild(slugs, docHandle, "sections", sectionSeq),
            content: "new body",
          }),
        },
      ],
      [
        "retitle_section",
        {
          // Title-only retitle keeps seq/sectionType stable, so it doesn't
          // perturb other cases that key off the shared section's seq.
          input: () => ({
            ref: refForChild(slugs, docHandle, "sections", sectionSeq),
            title: "RefEmit Retitled",
          }),
        },
      ],
      ["create_decision", { input: () => ({ ref: refForDoc(slugs, docHandle), title: "RefEmit Q" }) }],
      [
        "update_decision",
        {
          input: () => ({
            ref: refForChild(slugs, docHandle, "decisions", resolvedDecSeq),
            status: "open",
          }),
        },
      ],
      [
        "resolve_decision",
        {
          input: () => ({
            ref: refForChild(slugs, docHandle, "decisions", openDecSeq),
            resolution: "probe answer",
          }),
        },
      ],
      [
        "approve_candidate",
        { input: () => ({ ref: refForChild(slugs, docHandle, "decisions", candDecSeq1) }) },
      ],
      [
        "reject_candidate",
        {
          input: () => ({
            ref: refForChild(slugs, docHandle, "decisions", candDecSeq2),
            reason: "probe reject",
          }),
        },
      ],
      ["list_tasks", { input: () => ({ ref: refForDoc(slugs, docHandle) }) }],
      [
        "create_task",
        {
          input: () => ({
            ref: refForDoc(slugs, docHandle),
            title: "RefEmit new task",
            description: "x",
          }),
        },
      ],
      [
        "update_task",
        {
          input: () => ({
            ref: refForChild(slugs, docHandle, "tasks", taskSeq1),
            status: "in_progress",
          }),
        },
      ],
      ["delete_task", { input: () => ({ ref: refForChild(slugs, docHandle, "tasks", taskSeq2) }) }],
      [
        "add_comment",
        {
          input: () => ({
            ref: refForChild(slugs, docHandle, "sections", sectionSeq),
            authorName: "probe",
            content: "ref-emit comment",
          }),
        },
      ],
      ["list_comments", { input: () => ({ ref: refForChild(slugs, docHandle, "sections", sectionSeq) }) }],
      [
        "update_comment",
        {
          input: () => ({
            ref: refForChild(slugs, docHandle, "comments", commentSeq),
            status: "resolved",
          }),
        },
      ],
      ["publish_spec", { input: () => ({ ref: refForDoc(slugs, docInDraftHandle) }) }],
      [
        "create_ac",
        {
          input: () => ({
            ref: refForDoc(slugs, docHandle),
            kind: "scope",
            statement: "probe create_ac",
          }),
        },
      ],
      ["list_acs", { input: () => ({ ref: refForDoc(slugs, docHandle) }) }],
      ["get_ac", { input: () => ({ ref: refForChild(slugs, docHandle, "acs", acSeqForGet) }) }],
      [
        "update_ac",
        {
          input: () => ({
            ref: refForChild(slugs, docHandle, "acs", acSeqForUpdate),
            statement: "probe update_ac (updated)",
          }),
        },
      ],
      ["delete_ac", { input: () => ({ ref: refForChild(slugs, docHandle, "acs", acSeqForDelete) }) }],
      [
        "link_ac_to_decision",
        {
          input: () => ({
            ac_ref: refForChild(slugs, docHandle, "acs", acSeqForLink),
            decision_ref: refForChild(slugs, docHandle, "decisions", openDecSeq),
          }),
        },
      ],
      // ── Issues (spec-112) ──
      [
        "register_issue",
        {
          input: () => ({
            spec_ref: refForDoc(slugs, docHandle),
            title: "RefEmit registered issue",
            body: "x",
            type: "bug",
          }),
        },
      ],
      ["list_issues", { input: () => ({ ref: refForDoc(slugs, docHandle) }) }],
      ["get_issue", { input: () => ({ ref: refForChild(slugs, docHandle, "issues", issueSeqForGet) }) }],
      [
        "update_issue",
        {
          input: () => ({
            ref: refForChild(slugs, docHandle, "issues", issueSeqForUpdate),
            severity: "high",
          }),
        },
      ],
      [
        "resolve_issue",
        {
          input: () => ({
            ref: refForChild(slugs, docHandle, "issues", issueSeqForResolve),
            resolution: "wont_fix",
          }),
        },
      ],
      [
        "convert_issue_to_task",
        {
          input: () => ({
            ref: refForChild(slugs, docHandle, "issues", issueSeqForConvert),
          }),
        },
      ],
      [
        "kick_task_to_issue",
        {
          input: () => ({
            ref: refForChild(slugs, docHandle, "tasks", taskSeqForKick),
            reason: "needs offline DNS change",
          }),
        },
      ],
      // ── Per-Spec roles + assignment (spec-118) ──
      // All four take a Spec ref + (for the user-acting three) a user id. Each
      // emits the affected Spec/entity ref with no raw UUID in the terse body.
      ["get_spec_roles", { input: () => ({ ref: refForDoc(slugs, docHandle) }) }],
      [
        "set_spec_role",
        { input: () => ({ ref: refForDoc(slugs, docHandle), user: userId, role: "editor" }) },
      ],
      ["assign_spec", { input: () => ({ ref: refForDoc(slugs, docHandle), user: userId }) }],
      ["unassign_spec", { input: () => ({ ref: refForDoc(slugs, docHandle), user: userId }) }],
      // ── Standards drift tools (spec-143 dec-1) ──
      // Raw standard-section UUID in (no handle scheme), `ref:` to the comment
      // under the standard's std-N handle out.
      [
        "flag_drift",
        {
          input: () => ({
            standardSectionId: driftSectionId,
            observation: "RefEmit: the code no longer matches this rule.",
          }),
        },
      ],
      [
        "propose_standard_change",
        {
          input: () => ({
            standardSectionId: proposeSectionId,
            proposedContent: "RefEmit: corrected rule body.",
            rationale: "refemit rationale",
          }),
        },
      ],
    ]);
  }

  it("every catalogued shared spec is either probed here or skipped with justification", () => {
    const cases = casesByName();
    const missing: string[] = [];
    for (const spec of toolSpecs) {
      if (SKIPS.has(spec.name)) continue;
      if (!cases.has(spec.name)) missing.push(spec.name);
    }
    expect(
      missing,
      missing.length === 0
        ? ""
        : `Add either a case in casesByName() or a SKIPS entry with reason for: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("every probed terse response contains `ref:` and no raw UUID", async () => {
    const cases = casesByName();
    const failures: string[] = [];
    for (const [name, c] of cases) {
      const spec = toolSpecs.find((s) => s.name === name);
      if (!spec) {
        failures.push(`${name}: spec not registered`);
        continue;
      }
      try {
        const out = await spec.handler(c.input(), ctxForMemex(c.memexId ?? memexId, userId));
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
