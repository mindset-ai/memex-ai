// spec-521 t-3 — supersession: the primitive that says "this shipped, and a later
// Spec changed it".
//
// Archive could not express that. Archive means dead and WITHHOLDS content;
// supersession withholds nothing and only adds a pointer. That difference in
// consequence is why supersede_spec is agent-callable while archiving stays
// human-only (dec-6) — and it is why the guards below matter: an agent can set this,
// so the ways it could be set wrongly all have to be closed.
//
// The read-effect tests are the ones that actually carry ac-7. A pointer nobody sees
// is not a pointer, so the assertions walk EVERY read surface the AC names — the
// Spec, its ACs, its tasks, its comments — rather than trusting that one shared
// composition point covers them.
//
// std-37: per-worker-unique identifiers via makeTestMemexWithDevAdmin; teardown
// deletes only this file's rows.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { documents } from "../db/schema.js";
import { makeTestMemexWithDevAdmin, makeTestMemex } from "./test-helpers.js";
import { upsertUserByEmail } from "./users.js";
import { createDocDraft, archiveDoc } from "./documents.js";
import { createAc } from "./acs.js";
import { createTask } from "./tasks.js";
import {
  supersedeSpec,
  listPredecessors,
  SUPERSESSION_NOTE_MAX_LENGTH,
} from "./supersession.js";
import { executeServerTool } from "../agent/tools.js";
import { toolManifest } from "@memex/shared";
import { toolSpecs } from "../agent/tool-specs.js";
import { NotFoundError, ValidationError } from "../types/errors.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-521/acs/ac-${n}`;

const createdDocIds: string[] = [];
const REST: { channel: "rest_ui"; actorUserId?: string } = { channel: "rest_ui" };

let memexId: string;
let nsSlug: string;
let devUserId: string;
let otherMemexId: string;

const NOTE = "absorbed into the channel-aware footer projection";

async function makeSpec(title: string): Promise<{ id: string; handle: string; ref: string }> {
  const doc = await createDocDraft(
    memexId,
    title,
    `purpose of ${title}`,
    "spec",
    undefined,
    undefined,
    devUserId,
    { channel: "rest_ui", actorUserId: devUserId },
  );
  createdDocIds.push(doc.id);
  return { id: doc.id, handle: doc.handle, ref: `${nsSlug}/main/specs/${doc.handle}` };
}

beforeAll(async () => {
  const made = await makeTestMemexWithDevAdmin("s521sup");
  memexId = made.memexId;
  nsSlug = made.slug;
  const dev = await upsertUserByEmail("dev@memex.ai");
  devUserId = dev.id;
  REST.actorUserId = devUserId;
  otherMemexId = await makeTestMemex("s521other");
});

afterAll(async () => {
  // Clear the self-referential FK before deleting, so ON DELETE SET NULL ordering
  // cannot leave a row pinned.
  if (createdDocIds.length) {
    await db
      .update(documents)
      .set({ supersededByDocId: null })
      .where(inArray(documents.id, createdDocIds))
      .catch(() => {});
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
});

// ══════════════════════════════════════════════════════════════════
// ac-15 — the guards. One test each, because a guard covered only in aggregate is
// a guard you cannot tell is broken.
// ══════════════════════════════════════════════════════════════════

describe("ac-15 — supersede_spec refuses every malformed relationship", () => {
  it("refuses a Spec superseding itself", async () => {
    tagAc(AC(15));
    const a = await makeSpec("Self supersede");
    await expect(supersedeSpec(memexId, a.id, a.id, NOTE, REST)).rejects.toThrow(
      ValidationError,
    );
  });

  it("refuses a direct cycle (A→B then B→A)", async () => {
    tagAc(AC(15));
    const a = await makeSpec("Cycle A");
    const b = await makeSpec("Cycle B");
    await supersedeSpec(memexId, a.id, b.id, NOTE, REST);
    await expect(supersedeSpec(memexId, b.id, a.id, NOTE, REST)).rejects.toThrow(
      ValidationError,
    );
  });

  it("refuses a TRANSITIVE cycle (A→B, B→C, then C→A)", async () => {
    tagAc(AC(15));
    // The case a naive self-check would miss entirely.
    const a = await makeSpec("Chain A");
    const b = await makeSpec("Chain B");
    const c = await makeSpec("Chain C");
    await supersedeSpec(memexId, a.id, b.id, NOTE, REST);
    await supersedeSpec(memexId, b.id, c.id, NOTE, REST);
    await expect(supersedeSpec(memexId, c.id, a.id, NOTE, REST)).rejects.toThrow(
      ValidationError,
    );
  });

  it("refuses a successor in a DIFFERENT Memex, reporting it as absent not forbidden (std-7)", async () => {
    tagAc(AC(15));
    const mine = await makeSpec("Mine");
    const foreign = await createDocDraft(
      otherMemexId,
      "Foreign spec",
      "purpose",
      "spec",
      undefined,
      undefined,
      devUserId,
      REST,
    );
    createdDocIds.push(foreign.id);
    await expect(
      supersedeSpec(memexId, mine.id, foreign.id, NOTE, REST),
    ).rejects.toThrow(NotFoundError);
  });

  it("refuses when either side is not a Spec", async () => {
    tagAc(AC(15));
    const spec = await makeSpec("A real spec");
    const freeform = await createDocDraft(
      memexId,
      "A free-form doc",
      "purpose",
      "document",
      undefined,
      undefined,
      devUserId,
      REST,
    );
    createdDocIds.push(freeform.id);
    // Non-Spec as the successor.
    await expect(
      supersedeSpec(memexId, spec.id, freeform.id, NOTE, REST),
    ).rejects.toThrow(ValidationError);
    // Non-Spec as the subject.
    await expect(
      supersedeSpec(memexId, freeform.id, spec.id, NOTE, REST),
    ).rejects.toThrow(ValidationError);
  });

  it("refuses an ARCHIVED successor — a pointer into withheld content is worse than none", async () => {
    tagAc(AC(15));
    const pred = await makeSpec("Predecessor");
    const dead = await makeSpec("Archived successor");
    await archiveDoc(memexId, dead.id, REST, "parked");
    await expect(supersedeSpec(memexId, pred.id, dead.id, NOTE, REST)).rejects.toThrow(
      ValidationError,
    );
  });

  it("refuses a successor that is ITSELF superseded — point at current intent instead", async () => {
    tagAc(AC(15));
    const a = await makeSpec("Stale successor candidate");
    const b = await makeSpec("The real current one");
    await supersedeSpec(memexId, a.id, b.id, NOTE, REST);
    const c = await makeSpec("Wants to point at the stale one");
    await expect(supersedeSpec(memexId, c.id, a.id, NOTE, REST)).rejects.toThrow(
      ValidationError,
    );
  });

  it("caps the note at 280 characters, enforced at write", async () => {
    tagAc(AC(15));
    expect(SUPERSESSION_NOTE_MAX_LENGTH).toBe(280);
    const a = await makeSpec("Note cap");
    const b = await makeSpec("Note cap successor");
    await expect(
      supersedeSpec(memexId, a.id, b.id, "x".repeat(281), REST),
    ).rejects.toThrow(ValidationError);
    const ok = await supersedeSpec(memexId, a.id, b.id, "y".repeat(280), REST);
    expect(ok.supersessionNote).toHaveLength(280);
  });

  it("PERMITS many-to-one — several Specs may point at one successor", async () => {
    tagAc(AC(15));
    const successor = await makeSpec("The absorbing spec");
    const p1 = await makeSpec("Absorbed one");
    const p2 = await makeSpec("Absorbed two");
    const p3 = await makeSpec("Absorbed three");
    for (const p of [p1, p2, p3]) {
      await supersedeSpec(memexId, p.id, successor.id, NOTE, REST);
    }
    const preds = await listPredecessors(memexId, successor.id);
    expect(preds.map((p) => p.handle).sort()).toEqual(
      [p1.handle, p2.handle, p3.handle].sort(),
    );
  });

  it("clearing with supersededBy:null nulls all three columns in ONE call", async () => {
    tagAc(AC(15));
    const a = await makeSpec("To be cleared");
    const b = await makeSpec("Clear successor");
    const set = await supersedeSpec(memexId, a.id, b.id, NOTE, REST);
    expect(set.supersededByDocId).toBe(b.id);
    expect(set.supersededAt).toBeInstanceOf(Date);
    expect(set.supersessionNote).toBe(NOTE);

    const cleared = await supersedeSpec(memexId, a.id, null, null, REST);
    expect(cleared.supersededByDocId).toBeNull();
    expect(cleared.supersededAt).toBeNull();
    expect(cleared.supersessionNote).toBeNull();
  });

  it("records supersession at DOC grain only — no child entity gains a pointer", async () => {
    tagAc(AC(15));
    // dec-5: the columns live on `documents` and nowhere else. Assert structurally
    // against the live schema so adding one to decisions/sections later trips this.
    const cols = await db.execute<{ table_name: string; column_name: string }>(
      // biome-ignore lint/style/noUnusedTemplateLiteral: raw introspection query
      `select table_name, column_name from information_schema.columns
         where column_name in ('superseded_by_doc_id','superseded_at','supersession_note')
           and table_schema = 'public'`,
    );
    const rows = (cols as unknown as { rows?: { table_name: string; column_name: string }[] }).rows ?? (cols as unknown as { table_name: string; column_name: string }[]);
    const all = [...rows];

    // The POINTER and the note exist on `documents` and nowhere else. (`superseded_at`
    // alone is deliberately not asserted exclusive: experiment_assignments has
    // carried a same-named column since long before this Spec, for A/B assignment
    // supersession — an unrelated concept that happens to share the English word.)
    const pointerTables = all
      .filter((r) => r.column_name !== "superseded_at")
      .map((r) => r.table_name);
    expect(new Set(pointerTables)).toEqual(new Set(["documents"]));

    // And no CHILD entity of a Spec carries ANY of the three — the dec-5 claim.
    const childTables = [
      "decisions",
      "doc_sections",
      "acs",
      "tasks",
      "doc_comments",
      "issues",
      "standard_clauses",
    ];
    for (const t of all) {
      expect(childTables).not.toContain(t.table_name);
    }
  });

  it("the index the mirror lookup rides exists on documents (std-39)", async () => {
    tagAc(AC(15));
    const res = await db.execute<{ indexname: string }>(
      // biome-ignore lint/style/noUnusedTemplateLiteral: raw introspection query
      `select indexname from pg_indexes where tablename = 'documents'`,
    );
    const rows = (res as unknown as { rows?: { indexname: string }[] }).rows ?? (res as unknown as { indexname: string }[]);
    const names = [...rows].map((r) => r.indexname);
    expect(names).toContain("documents_superseded_by_doc_id_idx");
  });
});

// ══════════════════════════════════════════════════════════════════
// ac-7 — the read effects. The pointer is worthless if a read can miss it.
// ══════════════════════════════════════════════════════════════════

describe("ac-7 — every read of a superseded Spec leads with the pointer", () => {
  let pred: { id: string; handle: string; ref: string };
  let succ: { id: string; handle: string; ref: string };

  beforeAll(async () => {
    pred = await makeSpec("Predecessor with readable content");
    succ = await makeSpec("Successor carrying current intent");
    // Give the predecessor children, so the child-read surfaces have something to
    // return alongside the lead line.
    await createAc(
      { memexId, briefId: pred.id, kind: "scope", statement: "A predecessor AC." },
      REST,
    );
    await createTask(
      memexId,
      pred.id,
      "A predecessor task",
      "still listed",
      undefined,
      undefined,
      REST,
    );
    await supersedeSpec(memexId, pred.id, succ.id, NOTE, REST);
  });

  it("get_doc leads with the successor, the date and the note", async () => {
    tagAc(AC(7));
    const out = await executeServerTool(memexId, "get_doc", { ref: pred.ref }, devUserId);
    expect(out).toContain("SUPERSEDED BY");
    expect(out).toContain(succ.handle);
    expect(out).toContain(NOTE);
    expect(out).toMatch(/\d{1,2} \w{3} \d{4}/);
  });

  it("get_doc STILL SERVES the content — a superseded Spec is history, not a secret", async () => {
    tagAc(AC(7));
    // The contrast with archive is the whole point: archive WITHHOLDS and returns a
    // stub, supersession serves everything under a warning. Assert both halves of
    // that contrast on the surface the in-app agent actually gets (its ctx is always
    // terse, so section bodies are not in a get_doc response either way):
    const out = await executeServerTool(memexId, "get_doc", { ref: pred.ref }, devUserId);
    expect(out).toContain("SUPERSEDED BY");
    expect(out).toContain("Predecessor with readable content");
    // NOT a stub — none of the archive refusal's language appears.
    expect(out).not.toContain("Content withheld");
    expect(out).not.toContain("ARCHIVED");
    // And the children an archived Spec hides are fully enumerable here, with their
    // text — this is the assertion that proves content is served, not just named.
    const acs = await executeServerTool(memexId, "list_acs", { ref: pred.ref }, devUserId);
    expect(acs).toContain("A predecessor AC.");
    const tasks = await executeServerTool(memexId, "list_tasks", { ref: pred.ref }, devUserId);
    expect(tasks).toContain("A predecessor task");
  });

  it("list_acs leads with the pointer, so a decision cannot be read without it", async () => {
    tagAc(AC(7));
    const out = await executeServerTool(memexId, "list_acs", { ref: pred.ref }, devUserId);
    expect(out).toContain("SUPERSEDED BY");
    expect(out).toContain(succ.handle);
    expect(out).toContain("A predecessor AC.");
  });

  it("list_tasks leads with the pointer", async () => {
    tagAc(AC(7));
    const out = await executeServerTool(memexId, "list_tasks", { ref: pred.ref }, devUserId);
    expect(out).toContain("SUPERSEDED BY");
    expect(out).toContain(succ.handle);
  });

  it("list_comments leads with the pointer", async () => {
    tagAc(AC(7));
    const out = await executeServerTool(
      memexId,
      "list_comments",
      { ref: pred.ref },
      devUserId,
    );
    expect(out).toContain("SUPERSEDED BY");
  });

  it("the SUCCESSOR carries the mirror", async () => {
    tagAc(AC(7));
    const out = await executeServerTool(memexId, "get_doc", { ref: succ.ref }, devUserId);
    expect(out).toContain(`Replaces ${pred.handle}`);
  });

  it("the mirror is ONE line however many predecessors", async () => {
    tagAc(AC(7));
    const extra1 = await makeSpec("Also absorbed A");
    const extra2 = await makeSpec("Also absorbed B");
    await supersedeSpec(memexId, extra1.id, succ.id, NOTE, REST);
    await supersedeSpec(memexId, extra2.id, succ.id, NOTE, REST);
    const out = await executeServerTool(memexId, "get_doc", { ref: succ.ref }, devUserId);
    const replacesLines = out.split("\n").filter((l) => l.includes("Replaces "));
    expect(replacesLines).toHaveLength(1);
    expect(replacesLines[0]).toContain(extra1.handle);
    expect(replacesLines[0]).toContain(extra2.handle);
    expect(replacesLines[0]).toContain(pred.handle);
  });

  it("the readiness roll-up stops presenting its open work as commitments", async () => {
    tagAc(AC(7));
    // A superseded Spec with an incomplete task must not be reported as "Next:
    // complete t-1" — that is the wasted reconciliation this Spec exists to stop.
    const out = await executeServerTool(memexId, "get_doc", { ref: pred.ref }, devUserId);
    expect(out).toContain(`superseded by ${succ.handle}`);
    expect(out).not.toMatch(/Next: complete t-\d/);
  });

  it("clearing the pointer removes the lead line from every read", async () => {
    tagAc(AC(7));
    const a = await makeSpec("Recorded in error");
    const b = await makeSpec("Wrong successor");
    await supersedeSpec(memexId, a.id, b.id, NOTE, REST);
    const before = await executeServerTool(memexId, "get_doc", { ref: a.ref }, devUserId);
    expect(before).toContain("SUPERSEDED BY");

    await supersedeSpec(memexId, a.id, null, null, REST);
    const after = await executeServerTool(memexId, "get_doc", { ref: a.ref }, devUserId);
    expect(after).not.toContain("SUPERSEDED BY");
  });

  it("an ordinary Spec's reads gain NO supersession text at all", async () => {
    tagAc(AC(7));
    const plain = await makeSpec("Nothing to do with supersession");
    const out = await executeServerTool(memexId, "get_doc", { ref: plain.ref }, devUserId);
    expect(out).not.toContain("SUPERSEDED");
    expect(out).not.toContain("Replaces ");
  });

  it("supersede_spec is reachable as an MCP tool and set through it end to end", async () => {
    tagAc(AC(7));
    const a = await makeSpec("Set via the tool");
    const b = await makeSpec("Tool successor");
    const out = await executeServerTool(
      memexId,
      "supersede_spec",
      { ref: a.ref, supersededBy: b.ref, note: NOTE },
      devUserId,
    );
    expect(out).toContain(b.handle);
    const row = await db.query.documents.findFirst({ where: eq(documents.id, a.id) });
    expect(row?.supersededByDocId).toBe(b.id);
    expect(row?.supersessionNote).toBe(NOTE);
  });

  it("the tool clears with one call", async () => {
    tagAc(AC(7));
    const a = await makeSpec("Tool clear");
    const b = await makeSpec("Tool clear successor");
    await executeServerTool(
      memexId,
      "supersede_spec",
      { ref: a.ref, supersededBy: b.ref, note: NOTE },
      devUserId,
    );
    await executeServerTool(
      memexId,
      "supersede_spec",
      { ref: a.ref, supersededBy: null },
      devUserId,
    );
    const row = await db.query.documents.findFirst({ where: eq(documents.id, a.id) });
    expect(row?.supersededByDocId).toBeNull();
    expect(row?.supersededAt).toBeNull();
    expect(row?.supersessionNote).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
// std-16 — the manifest is the one source for the tool contract
// ══════════════════════════════════════════════════════════════════

describe("std-16 — supersede_spec is declared in lockstep", () => {
  it("appears in the @memex/shared manifest with the right group and hints", () => {
    tagAc(AC(15));
    const entry = toolManifest.find((e) => e.name === "supersede_spec");
    expect(entry).toBeDefined();
    expect(entry?.group).toBe("planning");
    expect(entry?.readOnlyHint).toBe(false);
    // Not phase-bound: a Spec can be superseded at any point, done included.
    expect(entry?.homePhase).toBeNull();
    expect(entry?.summary.length).toBeGreaterThan(0);
  });

  it("appears in the server catalogue too, so manifest and runtime agree", () => {
    tagAc(AC(15));
    const spec = toolSpecs.find((s) => s.name === "supersede_spec");
    expect(spec).toBeDefined();
    expect(spec?.annotations?.readOnlyHint).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════
// ac-16 — no archive/restore capability on any agent surface
// ══════════════════════════════════════════════════════════════════

describe("ac-16 — archiving and restoring stay human-only", () => {
  it("NO tool in the manifest archives or restores", () => {
    tagAc(AC(16));
    const names = toolManifest.map((e) => e.name);
    for (const forbidden of [
      "archive_doc",
      "archive_spec",
      "restore_doc",
      "restore_spec",
      "unarchive_doc",
      "unarchive_spec",
    ]) {
      expect(names).not.toContain(forbidden);
    }
    // Broader: nothing whose name or summary offers archiving as an agent action.
    const archiveish = toolManifest.filter(
      (e) => /archiv|unarchiv|restore/i.test(e.name),
    );
    expect(archiveish).toEqual([]);
  });

  it("NO tool in the server catalogue archives or restores", () => {
    tagAc(AC(16));
    const archiveish = toolSpecs.filter((s) => /archiv|unarchiv|restore/i.test(s.name));
    expect(archiveish).toEqual([]);
  });

  it("supersede_spec's own description points an agent at an Issue, not at archiving", () => {
    tagAc(AC(16));
    // dec-6: the sanctioned move when an agent thinks a Spec is dead is
    // register_issue while the Spec is still live. The tool that IS agent-callable
    // is where that distinction has to be taught, because it is the nearest
    // neighbour an agent will reach for.
    const spec = toolSpecs.find((s) => s.name === "supersede_spec");
    expect(spec?.description).toMatch(/Issue/);
    expect(spec?.description).toMatch(/human-only/);
  });
});
