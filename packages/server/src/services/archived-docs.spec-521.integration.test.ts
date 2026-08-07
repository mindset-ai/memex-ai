// spec-521 t-1 — archive must mean forget.
//
// THE DEFECT THIS FILE EXISTS TO PIN. Archive was honoured on every path that FINDS
// a doc (search's seven retrieval tiers, listDocs, getDoc) and on NO path that
// ADDRESSES one. An agent that never searched — following a cross-reference in a
// live Spec's prose, or reusing a ref from earlier in the session — resolved
// straight into an archived Spec and read its parked decisions as current intent.
// Because the gap was on the write side too, it could also edit one.
//
// WHY EVERY ASSERTION RUNS TWICE, ONCE PER SURFACE. The bug was born as an
// asymmetry: `isDemo` was guarded in BOTH agent-facing resolvers (copy-pasted), and
// its `archivedAt` twin was written in neither. A test that covers only the MCP
// surface, or only the in-app agent, reproduces exactly that failure mode — it would
// have passed on the day the bug shipped. So the two surfaces are exercised through
// their own real entry points:
//
//   * in-app agent  → executeServerTool(...)   (agent/tools.ts → resolveRefForAgent)
//   * coding agent  → resolveRefForUser(...)   (mcp/tools.ts, exported for tests)
//
// Neither is a hand-rolled copy of the resolver wrapper. Copying the wrapper into
// the test would assert that MY copy has the guard, which is worthless.
//
// std-37: every identifier is per-worker unique via makeTestMemex*'s uniqueSlug, and
// teardown deletes only what this file created.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { documents, memexes, namespaces } from "../db/schema.js";
import { makeTestMemex, makeTestMemexWithDevAdmin } from "./test-helpers.js";
import { upsertUserByEmail } from "./users.js";
import { createDocDraft, getDoc, archiveDoc, restoreDoc, listDocs } from "./documents.js";
import { createAc } from "./acs.js";
import { executeServerTool } from "../agent/tools.js";
import { resolveRefForUser } from "../mcp/tools.js";
import { handleError } from "../mcp/tools.js";
import { ArchivedDocError, NotFoundError, ValidationError } from "../types/errors.js";
import { ARCHIVE_REASON_MAX_LENGTH, formatArchivedDocStub } from "./archived-docs.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-521/acs/ac-${n}`;

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = resolve(__dirname, "..");

const createdDocIds: string[] = [];

let memexId: string;
let nsSlug: string;
let devUserId: string;

// The archived Spec every "must be inert" assertion points at.
let archivedRef: string;
let archivedAcRef: string;
let archivedSectionRef: string;
let archivedDocId: string;

// A LIVE Spec used as the control: the same reads that must fail on the archived
// Spec must still succeed here, or the test would pass for the wrong reason (a
// broken resolver refusing everything looks identical to a working guard).
let liveRef: string;
let liveAcRef: string;

// A SECOND, unrelated Memex — private (the schema default) with no membership for
// devUserId — holding its own archived Spec. Used only by the authorization-ordering
// block at the end of this file, which asserts the stub is never rendered ahead of
// the tenancy / read-access guards.
let foreignArchivedRef: string;

const ARCHIVE_REASON = "absorbed into the successor spec";
// Distinctive strings so a leak assertion can name exactly what must not appear.
const FOREIGN_TITLE = "Another tenant's parked work that must stay invisible";
const FOREIGN_REASON = "foreign tenant archive rationale";

beforeAll(async () => {
  const made = await makeTestMemexWithDevAdmin("s521arch");
  memexId = made.memexId;
  nsSlug = made.slug;
  const dev = await upsertUserByEmail("dev@memex.ai");
  devUserId = dev.id;

  const archived = await createDocDraft(
    memexId,
    "Parked work with decisions an agent must not read",
    "The premise moved elsewhere.",
    "spec",
    undefined,
    undefined,
    devUserId,
    { channel: "rest_ui", actorUserId: devUserId },
  );
  archivedDocId = archived.id;
  createdDocIds.push(archived.id);
  const archivedAc = await createAc(
    {
      memexId,
      briefId: archived.id,
      kind: "scope",
      statement: "An acceptance criterion that must become unreachable.",
    },
    { channel: "rest_ui", actorUserId: devUserId },
  );
  archivedRef = `${nsSlug}/main/specs/${archived.handle}`;
  archivedAcRef = `${archivedRef}/acs/ac-${archivedAc.seq}`;
  archivedSectionRef = `${archivedRef}/sections/s-${archived.sections[0].seq}`;

  const live = await createDocDraft(
    memexId,
    "Live work that must stay readable",
    "Still the current intent.",
    "spec",
    undefined,
    undefined,
    devUserId,
    { channel: "rest_ui", actorUserId: devUserId },
  );
  createdDocIds.push(live.id);
  const liveAc = await createAc(
    {
      memexId,
      briefId: live.id,
      kind: "scope",
      statement: "A live acceptance criterion.",
    },
    { channel: "rest_ui", actorUserId: devUserId },
  );
  liveRef = `${nsSlug}/main/specs/${live.handle}`;
  liveAcRef = `${liveRef}/acs/ac-${liveAc.seq}`;

  // Archive AFTER both Specs exist, with a reason and a real actor, so the stub has
  // every fact to render and the std-32 attribution is stamped at write.
  await archiveDoc(memexId, archived.id, { channel: "rest_ui", actorUserId: devUserId }, ARCHIVE_REASON);

  // The foreign Memex. makeTestMemex creates ns + org + memex and enrolls NOBODY, and
  // memexes.visibility defaults to 'private', so devUserId is a non-member with no
  // read access. The doc is seeded through the service layer (which applies no authz)
  // precisely so the ref is real and resolvable — the question under test is whether
  // the RESOLVER surfaces refuse it, not whether it can be created.
  const foreignMemexId = await makeTestMemex("s521foreign");
  const foreignSlug = await db
    .select({ slug: namespaces.slug })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(eq(memexes.id, foreignMemexId))
    .then((rows) => rows[0].slug);
  const foreignArchived = await createDocDraft(
    foreignMemexId,
    FOREIGN_TITLE,
    "Content belonging to a Memex the caller cannot read.",
    "spec",
    undefined,
    undefined,
    devUserId,
    { channel: "rest_ui", actorUserId: devUserId },
  );
  createdDocIds.push(foreignArchived.id);
  foreignArchivedRef = `${foreignSlug}/main/specs/${foreignArchived.handle}`;
  await archiveDoc(
    foreignMemexId,
    foreignArchived.id,
    { channel: "rest_ui", actorUserId: devUserId },
    FOREIGN_REASON,
  );
});

afterAll(async () => {
  if (createdDocIds.length) {
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
});

// ══════════════════════════════════════════════════════════════════
// ac-1 — a child ref on an archived Spec is not found, on BOTH surfaces
// ══════════════════════════════════════════════════════════════════

describe("ac-1 — child refs under an archived Spec are unreachable to agents", () => {
  it("MCP surface: an AC ref under an archived Spec resolves to not-found", async () => {
    tagAc(AC(1));
    await expect(resolveRefForUser(devUserId, archivedAcRef)).rejects.toThrow(NotFoundError);
  });

  it("MCP surface: the SAME read succeeds on a live Spec (the guard is not refusing everything)", async () => {
    tagAc(AC(1));
    const resolved = await resolveRefForUser(devUserId, liveAcRef);
    expect(resolved.entity.kind).toBe("ac");
  });

  it("in-app agent surface: get_ac on an archived Spec's AC is refused", async () => {
    tagAc(AC(1));
    await expect(
      executeServerTool(memexId, "get_ac", { ref: archivedAcRef }, devUserId),
    ).rejects.toThrow(NotFoundError);
  });

  it("in-app agent surface: get_ac on a LIVE Spec's AC still returns the AC", async () => {
    tagAc(AC(1));
    const out = await executeServerTool(memexId, "get_ac", { ref: liveAcRef }, devUserId);
    expect(out).toContain("A live acceptance criterion.");
  });

  it("in-app agent surface: list_acs on an archived Spec is refused, so its ACs cannot be enumerated", async () => {
    tagAc(AC(1));
    await expect(
      executeServerTool(memexId, "list_acs", { ref: archivedRef }, devUserId),
    ).rejects.toThrow(ArchivedDocError);
  });

  it("neither surface leaks the archived AC's text in the refusal", async () => {
    tagAc(AC(1));
    const mcpErr = await resolveRefForUser(devUserId, archivedAcRef).catch((e: Error) => e);
    const agentErr = await executeServerTool(
      memexId,
      "get_ac",
      { ref: archivedAcRef },
      devUserId,
    ).catch((e: Error) => e);
    for (const err of [mcpErr, agentErr]) {
      expect((err as Error).message).not.toContain("must become unreachable");
    }
  });
});

// ══════════════════════════════════════════════════════════════════
// ac-12 — the refusal is indistinguishable from a ref that never existed
// ══════════════════════════════════════════════════════════════════

describe("ac-12 — an archived Spec's child ref is indistinguishable from one that never existed", () => {
  // The strongest form of the claim, and the one a reason-string leak would break:
  // resolve a child under the ARCHIVED Spec, and a child under a Spec handle that
  // has never existed in this Memex, then compare the two messages BYTE FOR BYTE
  // after normalising the one part that legitimately differs — the ref itself.
  const NEVER_EXISTED_HANDLE = "spec-99999";

  // Both messages legitimately quote the ref the CALLER passed, and the ref carries
  // the Spec handle — so byte-equality is only meaningful once the caller-supplied
  // ref and handle are normalised out. What must be identical is everything else:
  // the wording, and critically the `reason` the surfaces interpolate. An
  // archived-specific reason (`archived_parent: …`) would survive this normalisation
  // and fail the assertion, which is exactly the leak being guarded against.
  const normalise = (msg: string, ref: string, handle: string) =>
    msg.split(ref).join("<REF>").split(handle).join("<HANDLE>");

  it("MCP surface: the two messages are identical once the caller-supplied ref is normalised", async () => {
    tagAc(AC(12));
    const archivedHandle = archivedRef.split("/specs/")[1];
    const ghostRef = `${nsSlug}/main/specs/${NEVER_EXISTED_HANDLE}/acs/ac-1`;
    const archivedErr = await resolveRefForUser(devUserId, archivedAcRef).catch((e: Error) => e);
    const ghostErr = await resolveRefForUser(devUserId, ghostRef).catch((e: Error) => e);

    expect(normalise((archivedErr as Error).message, archivedAcRef, archivedHandle)).toBe(
      normalise((ghostErr as Error).message, ghostRef, NEVER_EXISTED_HANDLE),
    );
  });

  it("MCP surface: the message is EXACTLY the doc-not-found form, character for character", async () => {
    tagAc(AC(12));
    // The unambiguous version of the claim: no normalisation, no comparison — assert
    // the literal string the resolver produces for a doc that does not exist at all.
    const archivedHandle = archivedRef.split("/specs/")[1];
    const err = (await resolveRefForUser(devUserId, archivedAcRef).catch(
      (e: Error) => e,
    )) as Error;
    expect(err.message).toBe(
      `Ref "${archivedAcRef}" not found (doc_not_found: specs/${archivedHandle} in ${nsSlug}/main)`,
    );
  });

  it("in-app agent surface: the two messages are identical once the caller-supplied ref is normalised", async () => {
    tagAc(AC(12));
    const archivedHandle = archivedRef.split("/specs/")[1];
    const ghostRef = `${nsSlug}/main/specs/${NEVER_EXISTED_HANDLE}/acs/ac-1`;
    const archivedErr = await executeServerTool(
      memexId,
      "get_ac",
      { ref: archivedAcRef },
      devUserId,
    ).catch((e: Error) => e);
    const ghostErr = await executeServerTool(
      memexId,
      "get_ac",
      { ref: ghostRef },
      devUserId,
    ).catch((e: Error) => e);

    expect(normalise((archivedErr as Error).message, archivedAcRef, archivedHandle)).toBe(
      normalise((ghostErr as Error).message, ghostRef, NEVER_EXISTED_HANDLE),
    );
  });

  it("the refusal never says the word 'archived' at the child grain", async () => {
    tagAc(AC(12));
    const mcpErr = await resolveRefForUser(devUserId, archivedAcRef).catch((e: Error) => e);
    const agentErr = await executeServerTool(
      memexId,
      "get_ac",
      { ref: archivedAcRef },
      devUserId,
    ).catch((e: Error) => e);
    for (const err of [mcpErr, agentErr]) {
      expect((err as Error).message.toLowerCase()).not.toContain("archiv");
      expect((err as Error).message).not.toContain(ARCHIVE_REASON);
    }
  });

  it("every child grain is covered — decisions, sections, tasks, comments, issues, ACs", async () => {
    tagAc(AC(12));
    const childRefs = [
      `${archivedRef}/acs/ac-1`,
      `${archivedRef}/decisions/dec-1`,
      `${archivedRef}/tasks/t-1`,
      `${archivedRef}/comments/c-1`,
      `${archivedRef}/issues/issue-1`,
      archivedSectionRef,
    ];
    for (const ref of childRefs) {
      await expect(resolveRefForUser(devUserId, ref)).rejects.toThrow(NotFoundError);
      await expect(
        executeServerTool(memexId, "get_doc", { ref }, devUserId),
      ).rejects.toThrow();
    }
  });

  it("the archive reason is capped at 280 characters, enforced at write", async () => {
    tagAc(AC(12));
    const victim = await createDocDraft(
      memexId,
      "Cap check",
      "purpose",
      "spec",
      undefined,
      undefined,
      devUserId,
      { channel: "rest_ui", actorUserId: devUserId },
    );
    createdDocIds.push(victim.id);
    expect(ARCHIVE_REASON_MAX_LENGTH).toBe(280);

    await expect(
      archiveDoc(
        memexId,
        victim.id,
        { channel: "rest_ui", actorUserId: devUserId },
        "x".repeat(ARCHIVE_REASON_MAX_LENGTH + 1),
      ),
    ).rejects.toThrow(ValidationError);

    // Exactly at the cap is allowed — an off-by-one here would be invisible.
    const ok = await archiveDoc(
      memexId,
      victim.id,
      { channel: "rest_ui", actorUserId: devUserId },
      "y".repeat(ARCHIVE_REASON_MAX_LENGTH),
    );
    expect(ok.archiveReason).toHaveLength(ARCHIVE_REASON_MAX_LENGTH);
  });
});

// ══════════════════════════════════════════════════════════════════
// ac-2 — the doc's own ref returns a stub: six facts, nothing else
// ══════════════════════════════════════════════════════════════════

describe("ac-2 — the archived Spec's own ref returns a stub, not its content", () => {
  it("MCP surface: resolving the doc ref throws ArchivedDocError carrying the stub", async () => {
    tagAc(AC(2));
    const err = await resolveRefForUser(devUserId, archivedRef).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ArchivedDocError);
    expect((err as Error).message).toContain("ARCHIVED");
  });

  it("in-app agent surface: get_doc on the archived Spec throws ArchivedDocError carrying the stub", async () => {
    tagAc(AC(2));
    const err = await executeServerTool(
      memexId,
      "get_doc",
      { ref: archivedRef },
      devUserId,
    ).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ArchivedDocError);
    expect((err as Error).message).toContain("ARCHIVED");
  });

  it("the stub carries exactly the six permitted facts", async () => {
    tagAc(AC(2));
    const err = (await resolveRefForUser(devUserId, archivedRef).catch(
      (e: Error) => e,
    )) as Error;
    const stub = err.message;

    // handle, title, archived-at, actor, phase-at-archive, reason
    expect(stub).toContain(archivedRef);
    expect(stub).toContain("Parked work with decisions an agent must not read");
    expect(stub).toMatch(/ARCHIVED \d{1,2} \w{3} \d{4}/);
    expect(stub).toContain("phase at archive:");
    expect(stub).toContain(ARCHIVE_REASON);
    // The archiving actor resolved from the threaded ctx, denormalised at write.
    const row = await db.query.documents.findFirst({
      where: eq(documents.id, archivedDocId),
    });
    expect(row?.archivedByName).toBeTruthy();
    expect(stub).toContain(row?.archivedByName as string);
  });

  it("the stub withholds the narrative, the decisions, the ACs and the tasks", async () => {
    tagAc(AC(2));
    const stub = (
      (await resolveRefForUser(devUserId, archivedRef).catch((e: Error) => e)) as Error
    ).message;
    expect(stub).not.toContain("must become unreachable");
    expect(stub).not.toContain("The premise moved elsewhere");
  });

  it("the stub emits NO COUNTS of anything — a count is itself an invitation to go looking", async () => {
    tagAc(AC(2));
    const stub = (
      (await resolveRefForUser(devUserId, archivedRef).catch((e: Error) => e)) as Error
    ).message;
    // A count would read as "<number> <thing>" — that shape must appear nowhere,
    // for any of the child kinds the stub is forbidden to quantify. Checked across
    // the whole stub rather than a filtered subset so a count smuggled onto the
    // ARCHIVED or Reason line is caught too.
    for (const noun of [
      "decision",
      "acceptance criteri",
      "task",
      "comment",
      "issue",
      "section",
      "AC",
    ]) {
      expect(stub).not.toMatch(new RegExp(`\\d+\\s+${noun}`, "i"));
    }
    // And the two lines that carry free-form-adjacent text must hold no digits at
    // all — the date is confined to the ARCHIVED line, and the handle to the first.
    const [, , ...tail] = stub.split("\n");
    expect(tail.join("\n")).not.toMatch(/\d/);
  });

  it("the stub names the restore path without instructing an MCP step that does not exist", async () => {
    tagAc(AC(2));
    const stub = (
      (await resolveRefForUser(devUserId, archivedRef).catch((e: Error) => e)) as Error
    ).message;
    expect(stub).toContain("A human can restore it in the archive view; agents cannot.");
    // ac-16 / std-34: no agent-callable restore exists, so the copy must not imply one.
    expect(stub).not.toMatch(/restore_doc|unarchive_doc|call\s+\w+\(/);
  });

  it("the MCP error mapping emits the stub VERBATIM — no 'Not found:' prefix contradicting it", () => {
    tagAc(AC(2));
    const stubText = "spec-1 — \"x\"\nARCHIVED 1 Jan 2026";
    const rendered = handleError(new ArchivedDocError(stubText));
    const text = JSON.stringify(rendered);
    expect(text).toContain("ARCHIVED");
    expect(text).not.toContain("Not found:");
  });

  it("both surfaces render the SAME stub — one shape, shared, not copied", async () => {
    tagAc(AC(2));
    const mcpStub = (
      (await resolveRefForUser(devUserId, archivedRef).catch((e: Error) => e)) as Error
    ).message;
    const agentStub = (
      (await executeServerTool(memexId, "get_doc", { ref: archivedRef }, devUserId).catch(
        (e: Error) => e,
      )) as Error
    ).message;
    expect(agentStub).toBe(mcpStub);

    // And both equal what the single shared formatter produces.
    const row = await db.query.documents.findFirst({ where: eq(documents.id, archivedDocId) });
    expect(mcpStub).toBe(formatArchivedDocStub(row!, archivedRef));
  });

  it("degrades honestly for a legacy archive with no recorded reason or actor", async () => {
    tagAc(AC(2));
    const legacy = await createDocDraft(
      memexId,
      "Archived before spec-521",
      "purpose",
      "spec",
      undefined,
      undefined,
      devUserId,
      { channel: "rest_ui", actorUserId: devUserId },
    );
    createdDocIds.push(legacy.id);
    // Simulate a pre-spec-521 row: archived_at set, attribution columns NULL.
    await db
      .update(documents)
      .set({ archivedAt: new Date(), archiveReason: null, archivedByName: null })
      .where(eq(documents.id, legacy.id));

    const legacyRef = `${nsSlug}/main/specs/${legacy.handle}`;
    const stub = (
      (await resolveRefForUser(devUserId, legacyRef).catch((e: Error) => e)) as Error
    ).message;
    expect(stub).toContain("Reason: not recorded");
    expect(stub).not.toContain("undefined");
    expect(stub).not.toContain("null");
  });
});

// ══════════════════════════════════════════════════════════════════
// ac-3 — every write against an archived Spec is refused
// ══════════════════════════════════════════════════════════════════

describe("ac-3 — writes against an archived Spec are refused before any handler runs", () => {
  it("in-app agent surface: update_section on an archived Spec's section is refused", async () => {
    tagAc(AC(3));
    await expect(
      executeServerTool(
        memexId,
        "update_section",
        { ref: archivedSectionRef, content: "an edit that must never land" },
        devUserId,
      ),
    ).rejects.toThrow(NotFoundError);
  });

  it("in-app agent surface: the refused write left the section content untouched", async () => {
    tagAc(AC(3));
    await executeServerTool(
      memexId,
      "update_section",
      { ref: archivedSectionRef, content: "an edit that must never land" },
      devUserId,
    ).catch(() => {});
    const doc = await getDoc(memexId, archivedDocId, { includeArchived: true });
    for (const s of doc.sections) {
      expect(s.content).not.toContain("an edit that must never land");
    }
  });

  it("in-app agent surface: create_task on an archived Spec is refused", async () => {
    tagAc(AC(3));
    await expect(
      executeServerTool(
        memexId,
        "create_task",
        { ref: archivedRef, title: "should not exist", description: "nope" },
        devUserId,
      ),
    ).rejects.toThrow(ArchivedDocError);
  });

  it("in-app agent surface: update_doc on an archived Spec is refused, naming it as archived", async () => {
    tagAc(AC(3));
    const err = await executeServerTool(
      memexId,
      "update_doc",
      { ref: archivedRef, status: "verify" },
      devUserId,
    ).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ArchivedDocError);
    // §5.3: a doc-level write gets the stub's refusal, which names the Spec as
    // archived so the agent stops rather than retrying.
    expect((err as Error).message).toContain("ARCHIVED");
  });

  it("MCP surface: resolving a section ref for a write is refused at the resolver", async () => {
    tagAc(AC(3));
    await expect(resolveRefForUser(devUserId, archivedSectionRef)).rejects.toThrow(
      NotFoundError,
    );
  });

  it("MCP surface: resolving the doc ref for a write is refused with the stub", async () => {
    tagAc(AC(3));
    await expect(resolveRefForUser(devUserId, archivedRef)).rejects.toThrow(ArchivedDocError);
  });

  it("the archived Spec's status was not changed by any refused write", async () => {
    tagAc(AC(3));
    const row = await db.query.documents.findFirst({ where: eq(documents.id, archivedDocId) });
    expect(row?.status).toBe("draft");
    expect(row?.archivedAt).toBeInstanceOf(Date);
  });
});

// ══════════════════════════════════════════════════════════════════
// ac-11 — the guard lives ONCE, in the canonical resolver, with no opt-in
// ══════════════════════════════════════════════════════════════════

describe("ac-11 — one guard, in the shared resolver, with no escape hatch", () => {
  const read = (rel: string) => readFileSync(resolve(SERVER_SRC, rel), "utf8");

  // These are structural assertions about CODE, so comments must be stripped before
  // matching — this Spec's own explanatory comments discuss `includeArchived` and
  // `doc.archivedAt` at length, and a naive whole-file regex would match the prose
  // that EXPLAINS the rule and report a violation of it.
  const code = (rel: string) =>
    read(rel)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.replace(/(^|\s)\/\/.*$/, "$1"))
      .join("\n");

  it("services/resolver.ts carries the archived guard", () => {
    tagAc(AC(11));
    expect(code("services/resolver.ts")).toMatch(/if\s*\(\s*doc\.archivedAt\s*\)/);
  });

  it("the canonical resolver exposes NO includeArchived-style opt-in", () => {
    tagAc(AC(11));
    // An escape hatch would be dead code on day one (dec-1) — and a future caller
    // reaching for it is how this guard would get quietly bypassed.
    const src = code("services/resolver.ts");
    expect(src).not.toMatch(/includeArchived/);
    expect(src).not.toMatch(/allowArchived|skipArchivedGuard/);
    // resolveRef takes exactly ONE parameter — its input ref. No options bag exists
    // for a future opt-in to be threaded through.
    expect(src).toMatch(/export async function resolveRef\(\s*input: string \| ParsedRef,\s*\)/);
  });

  it("NEITHER agent-facing resolver duplicates the archived check", () => {
    tagAc(AC(11));
    // This is the ac-11 assertion that matters. The isDemo guard is duplicated in
    // both of these files; the whole point of dec-1 is that its archivedAt twin is
    // NOT. If a future change copies the check here "for safety", the guard has two
    // homes that can drift apart — which is the bug this Spec fixed.
    for (const file of ["agent/tools.ts", "mcp/tools.ts"]) {
      const src = code(file);
      expect(src).not.toMatch(/doc\.archivedAt/);
      expect(src).not.toMatch(/\.archivedAt\s*(!==|===|\?)/);
      // The isDemo guard IS duplicated in both — proving the scan would catch a
      // duplicated archived check if one were ever added. Matched on the property
      // rather than a fixed receiver name: both surfaces now read it off the
      // `guardDoc` binding that the authorization-ordering fix introduced, and the
      // canary is about the guard existing, not about what the variable is called.
      expect(src).toMatch(/\.isDemo/);
    }
  });

  it("both agent-facing resolvers still call the canonical resolver, so they inherit it", () => {
    tagAc(AC(11));
    for (const file of ["agent/tools.ts", "mcp/tools.ts"]) {
      const src = code(file);
      expect(src).toMatch(/resolveRef as resolveCanonicalRef/);
      expect(src).toMatch(/await resolveCanonicalRef\(/);
      expect(src).toMatch(/"archivedDoc" in result/);
    }
  });

  it("the web content path is UNAFFECTED — getDoc with includeArchived still serves it", async () => {
    tagAc(AC(11));
    // The retracted over-blocking worry (Operations lens): the archive view and the
    // Pulse rows read through routes/documents.ts → getDoc/listDocs, which never
    // call the canonical resolver. If this broke, the archive view would be blank.
    const doc = await getDoc(memexId, archivedDocId, { includeArchived: true });
    expect(doc.id).toBe(archivedDocId);
    expect(doc.archivedAt).toBeInstanceOf(Date);
    expect(doc.sections.length).toBeGreaterThan(0);
    expect(doc.archiveReason).toBe(ARCHIVE_REASON);
  });

  it("the web archive listing can still enumerate archived docs", async () => {
    tagAc(AC(11));
    const archivedOnly = await listDocs(memexId, { includeArchived: true });
    expect(archivedOnly.some((d) => d.id === archivedDocId)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════
// ac-4 — restore, and the round trip
// ══════════════════════════════════════════════════════════════════

describe("ac-4 — archiving is reversible and loses nothing", () => {
  it("restore returns the Spec to the phase and content it had, and makes it readable again", async () => {
    tagAc(AC(4));
    const round = await createDocDraft(
      memexId,
      "Round trip",
      "purpose that must survive",
      "spec",
      undefined,
      undefined,
      devUserId,
      { channel: "rest_ui", actorUserId: devUserId },
    );
    createdDocIds.push(round.id);
    const roundRef = `${nsSlug}/main/specs/${round.handle}`;
    const statusBefore = round.status;
    const sectionsBefore = round.sections.length;

    await archiveDoc(
      memexId,
      round.id,
      { channel: "rest_ui", actorUserId: devUserId },
      "parked on suspicion",
    );
    // Inert while archived.
    await expect(resolveRefForUser(devUserId, roundRef)).rejects.toThrow(ArchivedDocError);

    await restoreDoc(memexId, round.id, { channel: "rest_ui", actorUserId: devUserId });

    // Readable again, same phase, same content — on BOTH surfaces.
    const resolved = await resolveRefForUser(devUserId, roundRef);
    expect(resolved.doc.status).toBe(statusBefore);
    expect(resolved.doc.archivedAt).toBeNull();
    const after = await getDoc(memexId, round.id);
    expect(after.sections.length).toBe(sectionsBefore);
    expect(after.sections.map((s) => s.content).join("\n")).toContain(
      "purpose that must survive",
    );
    const agentRead = await executeServerTool(memexId, "get_doc", { ref: roundRef }, devUserId);
    expect(agentRead).toContain("Round trip");
  });

  it("restore clears the archive attribution so a later archive cannot show a stale reason", async () => {
    tagAc(AC(4));
    const doc = await createDocDraft(
      memexId,
      "Attribution reset",
      "purpose",
      "spec",
      undefined,
      undefined,
      devUserId,
      { channel: "rest_ui", actorUserId: devUserId },
    );
    createdDocIds.push(doc.id);
    await archiveDoc(memexId, doc.id, { channel: "rest_ui", actorUserId: devUserId }, "first reason");
    const restored = await restoreDoc(memexId, doc.id, { channel: "rest_ui", actorUserId: devUserId });
    expect(restored.archiveReason).toBeNull();
    expect(restored.archivedByName).toBeNull();
    expect(restored.archivedByUserId).toBeNull();
  });

  it("restoring a live doc is an idempotent no-op, not an error", async () => {
    tagAc(AC(4));
    const doc = await createDocDraft(
      memexId,
      "Already live",
      "purpose",
      "spec",
      undefined,
      undefined,
      devUserId,
      { channel: "rest_ui", actorUserId: devUserId },
    );
    createdDocIds.push(doc.id);
    const out = await restoreDoc(memexId, doc.id, { channel: "rest_ui", actorUserId: devUserId });
    expect(out.archivedAt).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════
// ac-2 — the stub is rendered BELOW authorization, never above it
// ══════════════════════════════════════════════════════════════════
//
// A defect found while reviewing this Spec's own diff. Both surfaces originally threw
// the stub immediately after the resolver returned — the in-app agent ABOVE its
// `doc.memexId !== boundMemexId` tenancy check, and the MCP surface ABOVE
// `assertReadAccessForMemex` (the membership + OAuth `orgFilter` gate).
//
// That ordering leaks. `resolveRef` resolves purely from the caller-supplied ref
// string — namespace slug, memex slug, handle — and takes no caller identity, so the
// caller names the tenant. The stub is not an empty refusal: it carries the title, the
// archiving actor's name and the free-text reason. Rendered ahead of the gate, any
// authenticated caller could read those out of a Memex they have no access to, from a
// guessable slug plus a sequential `spec-N` handle.
//
// std-7 settles what the answer must be: an archived doc the caller cannot read is
// absent, exactly as a live one is — a plain NotFoundError, no stub. The Spec's own §2
// says the same ("Archived and superseded state leaks nothing about existence beyond
// what the caller could already see").
//
// Both surfaces are asserted, for the reason this whole file exists: the original bug
// was one surface carrying a guard the other lacked.
describe("ac-2 — an archived doc outside the caller's reach is absent, not stubbed", () => {
  it("MCP surface: a non-member's ref to a private Memex's archived Spec is refused by the read gate", async () => {
    tagAc(AC(2));
    const err = await resolveRefForUser(devUserId, foreignArchivedRef).catch((e: Error) => e);
    // The assertion is NOT ArchivedDocError: that class exists solely to carry the
    // stub, so receiving it here would mean the stub was built before the read gate
    // ran. Which refusal the caller does get is `assertReadAccessForMemex`'s existing,
    // deliberately uniform answer (McpAuthError, worded so "does not exist" and
    // "exists but you cannot see it" stay indistinguishable) — pre-existing behaviour
    // this Spec neither changes nor asserts.
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ArchivedDocError);
  });

  it("in-app agent surface: a ref outside the bound Memex is plain not-found", async () => {
    tagAc(AC(2));
    const err = await executeServerTool(
      memexId,
      "get_doc",
      { ref: foreignArchivedRef },
      devUserId,
    ).catch((e: Error) => e);
    // The in-app agent's tenancy guard is its own, and it IS a NotFoundError.
    expect(err).toBeInstanceOf(NotFoundError);
    expect(err).not.toBeInstanceOf(ArchivedDocError);
  });

  it("neither surface leaks the foreign Spec's title, reason or archiving actor", async () => {
    tagAc(AC(2));
    const mcpErr = await resolveRefForUser(devUserId, foreignArchivedRef).catch((e: Error) => e);
    const agentErr = await executeServerTool(
      memexId,
      "get_doc",
      { ref: foreignArchivedRef },
      devUserId,
    ).catch((e: Error) => e);
    for (const err of [mcpErr, agentErr]) {
      const msg = (err as Error).message;
      expect(msg).not.toContain(FOREIGN_TITLE);
      expect(msg).not.toContain(FOREIGN_REASON);
      // The std-32 denormalised actor name the stub would otherwise carry.
      expect(msg).not.toContain("dev@memex.ai");
      // And it must not even admit the doc is archived.
      expect(msg.toLowerCase()).not.toContain("archived");
    }
  });

  it("the control holds: inside the caller's own Memex the stub IS still served", async () => {
    tagAc(AC(2));
    // Without this, all three assertions above would pass on a resolver that had
    // simply stopped emitting stubs altogether.
    await expect(resolveRefForUser(devUserId, archivedRef)).rejects.toThrow(ArchivedDocError);
    await expect(
      executeServerTool(memexId, "get_doc", { ref: archivedRef }, devUserId),
    ).rejects.toThrow(ArchivedDocError);
  });
});
