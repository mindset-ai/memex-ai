// b-36 T-5 — canonical-ref resolver integration tests.
//
// Walks the resolver through every entity kind plus the redirect fallback:
//   1. Parse error → notFound (no DB touched).
//   2. Direct hits — spec, standard, doc, execution-plan, task, decision,
//      section (by seq), comment (by seq).
//   3. Redirect fallback — memex slug missing but redirect row present.
//   4. Prefix-match redirect — child path inherits parent redirect.
//   5. Genuine 404 — known memex, unknown doc handle, no redirect.
//
// Each test allocates a unique namespace slug + uses the standard "main"
// memex (matching makeTestMemex's convention). Redirect rows are scoped
// under those slugs so they don't leak across tests; afterEach prunes
// every redirect that mentions any test-owned namespace.

import { describe, it, expect, afterEach } from "vitest";
import { eq, sql, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import {
  namespaces,
  memexes,
  documents,
  docSections,
  orgs,
} from "../db/schema.js";
import { resolveRef } from "./resolver.js";
import { insertRedirect } from "./redirects.js";
import { createDocDraft } from "./documents.js";
import { addSection } from "./sections.js";
import { createDecision } from "./decisions.js";
import { createTask } from "./tasks.js";
import { addComment } from "./comments.js";

// ── Fixture helpers ────────────────────────────────────────────────────

function uniqueSlug(prefix: string): string {
  const tail = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}-${tail}`.toLowerCase().slice(0, 39);
}

// Build a namespace + org + memex tuple and return the slugs + ids the
// resolver tests need. Mirrors test-helpers.makeTestMemex but surfaces the
// slug pair so we can construct canonical refs.
async function makeMemexWithSlugs(label: string): Promise<{
  namespaceSlug: string;
  memexSlug: string;
  namespaceId: string;
  memexId: string;
}> {
  const namespaceSlug = uniqueSlug(`t5-${label}`);
  const memexSlug = "main";

  return db.transaction(async (tx) => {
    const [ns] = await tx
      .insert(namespaces)
      .values({ slug: namespaceSlug, kind: "org" })
      .returning();
    const [org] = await tx
      .insert(orgs)
      .values({ namespaceId: ns.id, name: `Test ${label}` })
      .returning();
    await tx
      .update(namespaces)
      .set({ ownerOrgId: org.id })
      .where(eq(namespaces.id, ns.id));
    const [mx] = await tx
      .insert(memexes)
      .values({ namespaceId: ns.id, slug: memexSlug, name: "Main" })
      .returning();
    return {
      namespaceSlug,
      memexSlug,
      namespaceId: ns.id,
      memexId: mx.id,
    };
  });
}

// Track every namespace slug we mint so the afterEach can wipe both the
// namespaces (cascading to memexes/docs/decisions/tasks/comments) AND any
// redirect rows referencing those slugs.
const createdNamespaceSlugs: string[] = [];

async function makeMemex(label: string) {
  const out = await makeMemexWithSlugs(label);
  createdNamespaceSlugs.push(out.namespaceSlug);
  return out;
}

afterEach(async () => {
  if (createdNamespaceSlugs.length === 0) return;
  const slugs = createdNamespaceSlugs.splice(0);

  // Wipe redirects touching any of these namespaces. LIKE-OR isn't worth
  // a join — we just iterate.
  for (const slug of slugs) {
    await db.execute(sql`
      DELETE FROM redirects
       WHERE old_path LIKE ${slug + "/%"}
          OR new_path LIKE ${slug + "/%"}
    `);
  }

  // Delete namespaces by slug. Cascades through orgs / memexes / documents
  // / sections / decisions / tasks / comments via the FK chain.
  await db.delete(namespaces).where(inArray(namespaces.slug, slugs));
});

// ── Tests ──────────────────────────────────────────────────────────────

describe("resolveRef (b-36 T-5)", () => {
  // 1. Parse error.
  it("rejects malformed input as parse_error", async () => {
    const r = await resolveRef("b36");
    expect(r).toEqual(
      expect.objectContaining({ notFound: true }),
    );
    expect((r as { reason: string }).reason).toMatch(/parse_error/);
  });

  // 2. Spec direct hit.
  it("resolves a spec by handle", async () => {
    const { namespaceSlug, memexSlug, memexId } = await makeMemex("spec-hit");
    const spec = await createDocDraft(memexId, "B", "purpose", "spec");

    const path = `${namespaceSlug}/${memexSlug}/specs/${spec.handle}`;
    const r = await resolveRef(path);

    expect(r).toEqual({
      found: true,
      entity: { kind: "spec", row: expect.objectContaining({ id: spec.id, docType: "spec" }) },
    });
  });

  // 3. Standard direct hit. Standards live on a separate handle path
  // (createStandard mints `std-N`), but the underlying row still goes
  // into documents — and we don't depend on createStandard here. Insert
  // a documents row with docType='standard' and handle='std-1' directly
  // to keep the test scoped to the resolver.
  it("resolves a standard by handle", async () => {
    const { namespaceSlug, memexSlug, memexId } = await makeMemex("std-hit");
    const [stdDoc] = await db
      .insert(documents)
      .values({
        memexId,
        handle: "std-1",
        title: "Coding standard",
        docType: "standard",
        status: "draft",
      })
      .returning();

    const path = `${namespaceSlug}/${memexSlug}/standards/${stdDoc.handle}`;
    const r = await resolveRef(path);

    expect(r).toEqual({
      found: true,
      entity: { kind: "standard", row: expect.objectContaining({ id: stdDoc.id, docType: "standard" }) },
    });
  });

  // 4. Doc direct hit (docType='document').
  it("resolves a doc (free-form document) by handle", async () => {
    const { namespaceSlug, memexSlug, memexId } = await makeMemex("doc-hit");
    const doc = await createDocDraft(memexId, "D", "purpose", "document");

    const path = `${namespaceSlug}/${memexSlug}/docs/${doc.handle}`;
    const r = await resolveRef(path);

    expect(r).toEqual({
      found: true,
      entity: { kind: "doc", row: expect.objectContaining({ id: doc.id, docType: "document" }) },
    });
  });

  // 5. Execution-plan direct hit.
  it("resolves an execution-plan by handle", async () => {
    const { namespaceSlug, memexSlug, memexId } = await makeMemex("xplan-hit");
    const plan = await createDocDraft(memexId, "P", "purpose", "execution_plan");

    const path = `${namespaceSlug}/${memexSlug}/execution-plans/${plan.handle}`;
    const r = await resolveRef(path);

    expect(r).toEqual({
      found: true,
      entity: { kind: "execution-plan", row: expect.objectContaining({ id: plan.id, docType: "execution_plan" }) },
    });
  });

  // 6. Task direct hit.
  it("resolves a task by handle on its parent spec", async () => {
    const { namespaceSlug, memexSlug, memexId } = await makeMemex("task-hit");
    const spec = await createDocDraft(memexId, "B", "purpose", "spec");
    const task = await createTask(memexId, spec.id, "Do thing", "Body");

    const path = `${namespaceSlug}/${memexSlug}/specs/${spec.handle}/tasks/t-${task.seq}`;
    const r = await resolveRef(path);

    expect(r).toEqual({
      found: true,
      entity: {
        kind: "task",
        row: expect.objectContaining({ id: task.id, seq: task.seq, docId: spec.id }),
        doc: expect.objectContaining({ id: spec.id }),
      },
    });
  });

  // 7. Decision direct hit.
  it("resolves a decision by handle on its parent spec", async () => {
    const { namespaceSlug, memexSlug, memexId } = await makeMemex("dec-hit");
    const spec = await createDocDraft(memexId, "B", "purpose", "spec");
    const dec = await createDecision(memexId, spec.id, "Pick a thing", "context");

    const path = `${namespaceSlug}/${memexSlug}/specs/${spec.handle}/decisions/dec-${dec.seq}`;
    const r = await resolveRef(path);

    expect(r).toEqual({
      found: true,
      entity: {
        kind: "decision",
        row: expect.objectContaining({ id: dec.id, seq: dec.seq, docId: spec.id }),
        doc: expect.objectContaining({ id: spec.id }),
      },
    });
  });

  // 8. Section direct hit, by seq.
  it("resolves a section by seq", async () => {
    const { namespaceSlug, memexSlug, memexId } = await makeMemex("sec-hit");
    const spec = await createDocDraft(memexId, "B", "purpose", "spec");
    // createDocDraft seeds seq=1 ("Overview"). addSection mints the next seq.
    const sec = await addSection(memexId, spec.id, "context", "body of section");

    const path = `${namespaceSlug}/${memexSlug}/specs/${spec.handle}/sections/s-${sec.seq}`;
    const r = await resolveRef(path);

    expect(r).toEqual({
      found: true,
      entity: {
        kind: "section",
        row: expect.objectContaining({ id: sec.id, seq: sec.seq, docId: spec.id }),
        doc: expect.objectContaining({ id: spec.id }),
      },
    });
  });

  // 9. Comment direct hit, by seq.
  it("resolves a comment by seq", async () => {
    const { namespaceSlug, memexSlug, memexId } = await makeMemex("com-hit");
    const spec = await createDocDraft(memexId, "B", "purpose", "spec");
    // Grab the seeded overview section to hang a comment on.
    const [seedSection] = await db
      .select()
      .from(docSections)
      .where(eq(docSections.docId, spec.id))
      .limit(1);
    const comment = await addComment(memexId, seedSection.id, "Alice", "first note");

    const path = `${namespaceSlug}/${memexSlug}/specs/${spec.handle}/comments/c-${comment.seq}`;
    const r = await resolveRef(path);

    expect(r).toEqual({
      found: true,
      entity: {
        kind: "comment",
        row: expect.objectContaining({ id: comment.id, seq: comment.seq, docId: spec.id }),
        doc: expect.objectContaining({ id: spec.id }),
      },
    });
  });

  // 10. Memex missing → redirect hit.
  //   Set up: real ns + memex "main"; record a redirect from
  //   "<ns>/old/specs/spec-1" → "<ns>/main/specs/spec-1". Look up the OLD
  //   path — the resolver should fail the memex lookup (no memex "old"
  //   under that namespace) and fall through to lookupRedirect.
  it("falls back to redirect when the memex slug is missing", async () => {
    const { namespaceSlug, memexSlug } = await makeMemex("mx-redir");
    const oldPath = `${namespaceSlug}/old-mx/specs/spec-1`;
    const newPath = `${namespaceSlug}/${memexSlug}/specs/spec-1`;
    await insertRedirect(oldPath, newPath, "brief_move");

    const r = await resolveRef(oldPath);
    expect(r).toEqual({ redirected: true, newRef: newPath });
  });

  // 11. Prefix-match redirect on a child path. The redirect row is for
  // the parent spec; the resolver's miss on the child path should
  // still feed the original input to lookupRedirect, which inherits
  // the redirect via the LIKE prefix match.
  it("falls back via prefix match for child paths", async () => {
    const { namespaceSlug, memexSlug } = await makeMemex("child-redir");
    const oldSpec = `${namespaceSlug}/old-mx/specs/spec-1`;
    const newSpec = `${namespaceSlug}/${memexSlug}/specs/spec-1`;
    await insertRedirect(oldSpec, newSpec, "brief_move");

    const oldChild = `${oldSpec}/tasks/t-1`;
    const expected = `${newSpec}/tasks/t-1`;

    const r = await resolveRef(oldChild);
    expect(r).toEqual({ redirected: true, newRef: expected });
  });

  // 12. Known memex but unknown doc handle and no redirect → notFound
  // with a reason that mentions the failing step.
  it("returns notFound when nothing matches and no redirect exists", async () => {
    const { namespaceSlug, memexSlug } = await makeMemex("ghost");
    const path = `${namespaceSlug}/${memexSlug}/specs/spec-99999`;

    const r = await resolveRef(path);
    expect(r).toEqual(
      expect.objectContaining({ notFound: true }),
    );
    expect((r as { reason: string }).reason).toMatch(/doc_not_found|spec-99999/);
  });
});

