// spec-521 t-2 — list_docs returns every phase except archived, and says what it hid.
//
// THE REPORTED FAILURE. "What Specs tagged `testbash` mention login?" returned
// nothing. The cause was `statusIn: ["specify","build","verify"]` hardcoded in the
// handler: every draft Spec was dropped. `search_memex` has no tag argument, so a
// tag-shaped question can only be asked of list_docs — the one path that silently
// narrowed the set. The answer was wrong and nothing said so.
//
// The fix is NOT "widen the filter". dec-3 is explicit that the narrow default was
// never the problem — its INVISIBILITY was. So this file asserts two things with
// equal weight: that the set is now everything-but-archived (ac-6, ac-13), and that
// the response STATES what it withheld (ac-8). A widened default with a silent
// filter would satisfy the first and reproduce the bug through the second.
//
// std-37: per-worker-unique identifiers; teardown scoped to this file's rows.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { documents } from "../db/schema.js";
import { makeTestMemexWithDevAdmin } from "../services/test-helpers.js";
import { upsertUserByEmail } from "../services/users.js";
import {
  createDocDraft,
  updateDocStatus,
  archiveDoc,
} from "../services/documents.js";
import { applyTagString } from "../services/tags.js";
import { supersedeSpec } from "../services/supersession.js";
import { executeServerTool } from "./tools.js";
import { toolManifest } from "@memex/shared";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-521/acs/ac-${n}`;

const createdDocIds: string[] = [];
const REST: { channel: "rest_ui"; actorUserId?: string } = { channel: "rest_ui" };

let memexId: string;
let devUserId: string;

// One Spec per phase, plus an archived one and a superseded one, so a single
// list_docs call can be asserted against the whole matrix.
const byPhase: Record<string, { id: string; handle: string; title: string }> = {};
let archivedHandle: string;
let supersededHandle: string;
let successorHandle: string;

const TAG = "testbash";

async function makeSpec(title: string, status?: string) {
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
  if (status && status !== "draft") {
    await updateDocStatus(memexId, doc.id, status, { source: "rest", ctx: REST });
  }
  return { id: doc.id, handle: doc.handle, title };
}

beforeAll(async () => {
  const made = await makeTestMemexWithDevAdmin("s521list");
  memexId = made.memexId;
  const dev = await upsertUserByEmail("dev@memex.ai");
  devUserId = dev.id;
  REST.actorUserId = devUserId;

  for (const phase of ["draft", "specify", "build", "verify", "done"]) {
    byPhase[phase] = await makeSpec(`Login flow in ${phase}`, phase);
    // Tag every one, so the tag-filtered query the user actually ran is the query
    // under test rather than an approximation of it.
    await applyTagString(REST, memexId, byPhase[phase].id, TAG);
  }

  const archived = await makeSpec("Login flow archived", "specify");
  archivedHandle = archived.handle;
  await applyTagString(REST, memexId, archived.id, TAG);
  await archiveDoc(memexId, archived.id, REST, "premise gone");

  const pred = await makeSpec("Login flow superseded", "verify");
  const succ = await makeSpec("Login flow successor", "build");
  supersededHandle = pred.handle;
  successorHandle = succ.handle;
  await applyTagString(REST, memexId, pred.id, TAG);
  await supersedeSpec(memexId, pred.id, succ.id, "absorbed", REST);
});

afterAll(async () => {
  if (createdDocIds.length) {
    await db
      .update(documents)
      .set({ supersededByDocId: null })
      .where(inArray(documents.id, createdDocIds))
      .catch(() => {});
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
});

const listDocsTool = (input: Record<string, unknown> = {}) =>
  executeServerTool(memexId, "list_docs", input, devUserId);

// ══════════════════════════════════════════════════════════════════
// ac-6 / ac-13 — every phase in, archived out
// ══════════════════════════════════════════════════════════════════

describe("ac-6 — every Spec except an archived one is visible by default", () => {
  it("returns DRAFT Specs — the exact regression that returned nothing", async () => {
    tagAc(AC(6));
    const out = await listDocsTool();
    expect(out).toContain(byPhase.draft.handle);
  });

  it("returns DONE Specs", async () => {
    tagAc(AC(6));
    const out = await listDocsTool();
    expect(out).toContain(byPhase.done.handle);
  });

  it("returns specify, build and verify Specs as before", async () => {
    tagAc(AC(6));
    const out = await listDocsTool();
    for (const phase of ["specify", "build", "verify"]) {
      expect(out).toContain(byPhase[phase].handle);
    }
  });

  it("EXCLUDES archived Specs — the only exclusion", async () => {
    tagAc(AC(6));
    const out = await listDocsTool();
    expect(out).not.toContain(archivedHandle);
  });

  it("the ORIGINAL failing query now works: tag-filtered, draft Specs included", async () => {
    tagAc(AC(6));
    // This is the user's report, reproduced: "what Specs tagged `testbash` mention
    // login?" A tag-shaped question can only be asked of list_docs, and before the
    // fix this returned nothing for the draft Spec.
    const out = await listDocsTool({ tags: [TAG] });
    expect(out).toContain(byPhase.draft.handle);
    expect(out).toContain(byPhase.done.handle);
    expect(out).not.toContain(archivedHandle);
  });

  it("statusIn NARROWS to the phases asked for, and nothing else", async () => {
    tagAc(AC(6));
    const out = await listDocsTool({ statusIn: ["specify", "build", "verify"] });
    expect(out).toContain(byPhase.specify.handle);
    expect(out).toContain(byPhase.build.handle);
    expect(out).toContain(byPhase.verify.handle);
    expect(out).not.toContain(byPhase.draft.handle);
    expect(out).not.toContain(byPhase.done.handle);
  });

  it("statusIn can never resurrect an archived Spec", async () => {
    tagAc(AC(6));
    const out = await listDocsTool({ statusIn: ["specify"] });
    expect(out).not.toContain(archivedHandle);
  });

  it("the hardcoded whitelist is GONE from the handler source", async () => {
    tagAc(AC(13));
    const { readFileSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, "handlers/docs.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.replace(/(^|\s)\/\/.*$/, "$1"))
      .join("\n");
    // The defect's shape was a hardcoded ARRAY LITERAL assigned to statusIn and
    // passed into listDocs. Asserted as an object-literal property at line start, so
    // this catches the whitelist returning in any phase combination while still
    // allowing the legitimate `statusIn: z.array(...)` schema declaration and the
    // header's own "narrow with statusIn: [...]" advice text.
    expect(src).not.toMatch(/^\s*statusIn:\s*\[/m);
    // And the query itself must no longer carry a phase filter at all — the phase
    // partition happens in memory so the header can report honest totals.
    const listDocsCall = src.slice(src.indexOf("const everything = await listDocs("));
    expect(listDocsCall.slice(0, 400)).not.toContain("statusIn");
  });
});

// ══════════════════════════════════════════════════════════════════
// ac-8 — the response never hides rows without saying so
// ══════════════════════════════════════════════════════════════════

describe("ac-8 — the header states the total, the shown count, and what was withheld", () => {
  it("states all three numbers when something IS withheld", async () => {
    tagAc(AC(8));
    const out = await listDocsTool();
    const header = out.split("\n")[0];
    // 7 live (5 phases + superseded pred + successor), 1 archived → 7 of 8.
    expect(header).toMatch(/\d+ of \d+/);
    expect(header).toContain("1 archived, hidden");
  });

  it("the totals are ARITHMETICALLY RIGHT, not just present", async () => {
    tagAc(AC(8));
    // A header that says "N of M" but computes either number wrongly is the same
    // class of defect as no header at all — it just lies more confidently.
    const out = await listDocsTool();
    const m = out.split("\n")[0].match(/(\d+) of (\d+)/);
    expect(m).toBeTruthy();
    const shown = Number(m?.[1]);
    const total = Number(m?.[2]);
    const rowCount = out.split("\n").filter((l) => l.startsWith("- ref: ")).length;
    expect(shown).toBe(rowCount);
    // Exactly one archived Spec was created by this file.
    expect(total - shown).toBe(1);
  });

  it("names the statusIn narrowing as a withholding too, when the caller narrows", async () => {
    tagAc(AC(8));
    const out = await listDocsTool({ statusIn: ["build"] });
    const header = out.split("\n")[0];
    expect(header).toContain("outside statusIn");
    expect(header).toContain("build");
    // The archived one is still reported separately — two different reasons a row is
    // missing must not collapse into one number.
    expect(header).toContain("archived, hidden");
  });

  it("says so explicitly when NOTHING was withheld", async () => {
    tagAc(AC(8));
    // The honest-header rule cuts both ways: silence would leave the caller guessing
    // whether a filter applied.
    const clean = await makeTestMemexWithDevAdmin("s521clean");
    const doc = await createDocDraft(
      clean.memexId,
      "Only spec",
      "purpose",
      "spec",
      undefined,
      undefined,
      devUserId,
      REST,
    );
    createdDocIds.push(doc.id);
    const out = await executeServerTool(clean.memexId, "list_docs", {}, devUserId);
    expect(out.split("\n")[0]).toContain("nothing withheld");
  });

  it("tells the caller HOW to narrow, when it has not", async () => {
    tagAc(AC(8));
    const out = await listDocsTool();
    expect(out.split("\n")[0]).toContain("statusIn");
  });

  it("the EMPTY result still states the totals", async () => {
    tagAc(AC(8));
    // "no results" and "no results in the slice you asked for" are different answers.
    const out = await listDocsTool({ statusIn: ["nonexistent-phase"] });
    expect(out).toContain("of ");
    expect(out).toContain("outside statusIn");
  });
});

// ══════════════════════════════════════════════════════════════════
// ac-13 — superseded rows stay, and carry their successor
// ══════════════════════════════════════════════════════════════════

describe("ac-13 — a superseded Spec stays in the list, marked", () => {
  it("remains in the default set", async () => {
    tagAc(AC(13));
    const out = await listDocsTool();
    expect(out).toContain(supersededHandle);
  });

  it("its row carries the successor, so the list itself says it was replaced", async () => {
    tagAc(AC(13));
    const out = await listDocsTool();
    const row = out
      .split("\n")
      .find((l) => l.startsWith("- ref: ") && l.includes(`/${supersededHandle}`));
    expect(row).toBeDefined();
    expect(row).toContain(`superseded by ${successorHandle}`);
  });

  it("an unsuperseded row carries no such marker", async () => {
    tagAc(AC(13));
    const out = await listDocsTool();
    const row = out
      .split("\n")
      .find((l) => l.startsWith("- ref: ") && l.includes(`/${byPhase.build.handle}`));
    expect(row).toBeDefined();
    expect(row).not.toContain("superseded by");
  });

  it("rows still carry their decision and task counts", async () => {
    tagAc(AC(13));
    // The counts moved from a per-row fan-out to two bulk GROUP BY queries
    // (std-39 cl-5); the numbers a caller sees must not have changed.
    const out = await listDocsTool();
    expect(out).toMatch(/\(\d+ decisions, \d+ tasks\)/);
  });
});

// ══════════════════════════════════════════════════════════════════
// std-16 — the manifest states the default in words
// ══════════════════════════════════════════════════════════════════

describe("std-16 — the manifest summary states the new default", () => {
  it("names every included phase and the single exclusion", () => {
    tagAc(AC(13));
    const entry = toolManifest.find((e) => e.name === "list_docs");
    expect(entry).toBeDefined();
    const summary = entry?.summary ?? "";
    for (const phase of ["draft", "specify", "build", "verify", "done"]) {
      expect(summary).toContain(phase);
    }
    expect(summary.toLowerCase()).toContain("archived");
    expect(entry?.args).toContain("statusIn");
  });
});
