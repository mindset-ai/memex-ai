// spec-535 t-9 — the closing invariants, plus the licence guard dec-5 owes.
//
// These are the claims that span the whole Spec rather than any one task, so no
// single implementation task could hold them:
//
//   ac-14  every file this Spec touched is fair-code — no EE marker
//   ac-15  no steward relation was introduced; the contact comes from the flag's
//          own provenance, never from checkout / assignees / doc members
//   ac-16  re-flagging moves the contact, and the three existing "who" relations
//          cannot move it
//   ac-1   sensitive and complex are ONE flag, recorded as a first-class fact
//   ac-2   an agent reading a flagged Spec meets the warning before the content
//   ac-5   the warning is distinct from ordinary metadata (MCP half; the web half
//          is pinned in SensitiveBanner.test.tsx and journey-70)

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { documents } from "../db/schema.js";
import { createDocDraft, setSensitive } from "../services/documents.js";
import { assign } from "../services/doc-assignees.js";
import { stampCheckout } from "../services/checkout.js";
import { upsertUserByEmail } from "../services/users.js";
import { makeTestMemex } from "../services/test-helpers.js";
import { formatFullDocState } from "../formatting/formatters.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-535/acs/ac-${n}`;

const REPO_ROOT = join(__dirname, "../../../..");

// Every file spec-535 introduced or edited, repo-relative — the list `git diff
// develop --name-only` produced at close-out. All must stay fair-code.
const SPEC_535_FILES = [
  "packages/server/drizzle/0132_spec535_sensitive_flag.sql",
  "packages/server/src/agent/handlers/lifecycle.ts",
  "packages/server/src/agent/set-sensitive.spec-535.integration.test.ts",
  "packages/server/src/agent/tool-specs.audit.integration.test.ts",
  "packages/server/src/db/schema.ts",
  "packages/server/src/formatting/formatters.ts",
  "packages/server/src/mcp/ac-nag-sketch.test.ts",
  "packages/server/src/mcp/footer-delimiter.spec-203.test.ts",
  "packages/server/src/mcp/formatters.handoff-essence.spec-203.test.ts",
  "packages/server/src/mcp/formatters.handoff-fulldelivery.spec-203.test.ts",
  "packages/server/src/mcp/formatters.injected-blocks.spec-203.test.ts",
  "packages/server/src/mcp/formatters.test.ts",
  "packages/server/src/mcp/spec-shape-lens-parity.test.ts",
  "packages/server/src/mcp/tools.test.ts",
  "packages/server/src/__regression__/mutate-coverage.endpoint.regression.test.ts",
  "packages/server/src/__regression__/ref-emission.regression.test.ts",
  "packages/server/src/__regression__/spec-535-sensitive-flag-schema.regression.test.ts",
  "packages/server/src/__regression__/spec-535-closeout.regression.test.ts",
  "packages/server/src/routes/documents.sensitive.spec-535.integration.test.ts",
  "packages/server/src/routes/documents.test.ts",
  "packages/server/src/routes/documents.ts",
  "packages/server/src/services/checkout-gate.ts",
  "packages/server/src/services/documents.sensitive.spec-535.integration.test.ts",
  "packages/server/src/services/documents.ts",
  "packages/server/src/services/standards.ts",
  "packages/shared/src/index.ts",
  "packages/shared/src/scaffold-data.ts",
  "packages/shared/src/tool-manifest.ts",
  "packages/ui/e2e/journey-70-spec-535-sensitive-flag.spec.ts",
  "packages/ui/src/api/docs.ts",
  "packages/ui/src/api/types.ts",
  "packages/ui/src/components/BylineSensitive.test.tsx",
  "packages/ui/src/components/BylineSensitive.tsx",
  "packages/ui/src/components/SensitiveBanner.test.tsx",
  "packages/ui/src/components/SensitiveBanner.tsx",
  "packages/ui/src/pages/DocDocument.tsx",
];

/** The licence marker IS the file path: `.ee.` in the basename or `.ee` as a directory. */
function isEeMarked(repoRelPath: string): boolean {
  const segments = repoRelPath.split("/");
  const base = segments.pop() ?? "";
  return base.includes(".ee.") || segments.includes(".ee");
}

describe("spec-535 t-9: close-out invariants", () => {
  let memexId: string;
  const createdDocIds: string[] = [];

  beforeAll(async () => {
    memexId = await makeTestMemex("closeout");
  });

  afterAll(async () => {
    for (const id of createdDocIds) await db.delete(documents).where(eq(documents.id, id));
  });

  async function makeDoc(title: string): Promise<string> {
    const doc = await createDocDraft(memexId, title, "purpose", "spec");
    createdDocIds.push(doc.id);
    return doc.id;
  }

  // ── ac-14 — the licence guard dec-5 owes ────────────────────────────────
  it("ac-14: every file this Spec touched is fair-code, and every listed file exists", () => {
    tagAc(AC(14));

    const eeMarked = SPEC_535_FILES.filter(isEeMarked);
    expect(
      eeMarked,
      `These spec-535 files carry the EE marker, which re-licenses them under the ` +
        `Memex Enterprise License. dec-5 resolved this Spec as fair-code:\n  - ${eeMarked.join("\n  - ")}`,
    ).toEqual([]);

    // A list that has silently rotted asserts nothing. If a file was renamed or
    // deleted, this fails and the list gets corrected rather than quietly
    // covering fewer files each release.
    const missing = SPEC_535_FILES.filter((p) => !existsSync(join(REPO_ROOT, p)));
    expect(
      missing,
      `Listed by the fair-code scan but no longer on disk — update the list:\n  - ${missing.join("\n  - ")}`,
    ).toEqual([]);
  });

  // ── ac-15 — no fourth "who" concept ─────────────────────────────────────
  it("ac-15: no steward relation exists — no column, no table", async () => {
    tagAc(AC(15));

    const cols = (await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'documents'
    `)) as unknown as Array<{ column_name: string }>;
    const names = cols.map((c) => c.column_name);

    // dec-2 declined to create the fourth "who" concept spec-506 dec-4 has an
    // open question about. If someone adds it later, they should have to reopen
    // that decision — not discover it already built.
    expect(names).not.toContain("steward_user_id");
    expect(names).not.toContain("steward_by_user_id");

    const tables = (await db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name LIKE '%steward%'
    `)) as unknown as Array<{ table_name: string }>;
    expect(tables).toHaveLength(0);
  });

  // ── ac-16 — the contact is the flag's own, not borrowed ─────────────────
  it("ac-16: re-flagging moves the contact; checkout and assignment cannot", async () => {
    tagAc(AC(16));
    const first = await upsertUserByEmail("spec535-first@example.com");
    const second = await upsertUserByEmail("spec535-second@example.com");
    const third = await upsertUserByEmail("spec535-third@example.com");
    const docId = await makeDoc("Closeout Contact Spec");

    await setSensitive(memexId, docId, { actorUserId: first.id, channel: "rest_ui" });
    let [row] = await db.select().from(documents).where(eq(documents.id, docId));
    expect(row.sensitiveByUserId).toBe(first.id);

    // Re-flagging moves it: the provenance answers "who to ask NOW", not "who
    // first noticed".
    await setSensitive(memexId, docId, { actorUserId: second.id, channel: "mcp" });
    [row] = await db.select().from(documents).where(eq(documents.id, docId));
    expect(row.sensitiveByUserId).toBe(second.id);

    // A third party taking the checkout does NOT become the contact. This is the
    // correctness reason dec-2 refused to reuse checked_out_by: it supersedes on
    // every new claim, so the contact would silently follow whoever last touched
    // the Spec.
    await stampCheckout({ docId, userId: third.id, thread: "some-session" });
    [row] = await db.select().from(documents).where(eq(documents.id, docId));
    expect(row.sensitiveByUserId).toBe(second.id);

    // Nor does assignment. dec-2 refused doc_assignees too, because spec-traffic
    // auto-assigns any agent that makes a mutating call — so any passing agent
    // would have become the "contact".
    await assign(memexId, docId, third.id, third.id, {
      actorUserId: third.id,
      channel: "rest_ui",
    });
    [row] = await db.select().from(documents).where(eq(documents.id, docId));
    expect(row.sensitiveByUserId).toBe(second.id);
  });

  // ── ac-1 — one flag, first-class, not inferred ──────────────────────────
  it("ac-1: sensitivity is its own recorded fact, and sensitive/complex are one flag", async () => {
    tagAc(AC(1));
    const holder = await upsertUserByEmail("spec535-holder-only@example.com");
    const docId = await makeDoc("Closeout Inference Spec");

    // Held, assigned — and still NOT sensitive. The whole premise of this Spec is
    // that "is this dangerous to touch" is not derivable from who is on it.
    await stampCheckout({ docId, userId: holder.id, thread: "s" });
    await assign(memexId, docId, holder.id, holder.id, {
      actorUserId: holder.id,
      channel: "rest_ui",
    });
    const [row] = await db.select().from(documents).where(eq(documents.id, docId));
    expect(row.sensitive).toBe(false);

    // And there is exactly ONE flag — no severity, level, or kind column that
    // would reopen the graded-enum dec-1 rejected.
    const cols = (await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'documents'
        AND column_name LIKE 'sensitive%'
    `)) as unknown as Array<{ column_name: string }>;
    expect(cols.map((c) => c.column_name).sort()).toEqual([
      "sensitive",
      "sensitive_by_name",
      "sensitive_by_user_id",
    ]);
  });

  // ── ac-2 / ac-5 — the agent meets the warning before the content ────────
  it("ac-2: an agent reading a flagged Spec meets the warning before any content", async () => {
    tagAc(AC(2));
    const docId = await makeDoc("Closeout Read Order Spec");
    const flagger = await upsertUserByEmail("spec535-reader-contact@example.com");
    await setSensitive(memexId, docId, { actorUserId: flagger.id, channel: "mcp" });

    const [row] = await db.select().from(documents).where(eq(documents.id, docId));
    const out = formatFullDocState({ ...row, sections: [] } as never, [], []);

    // Present, names the contact, and carries the action.
    expect(out).toContain("⚠");
    expect(out.toLowerCase()).toContain("contact");
    expect(out).toContain(row.sensitiveByName as string);
  });

  it("ac-5: on the MCP surface the warning is not another metadata line", async () => {
    tagAc(AC(5));
    const docId = await makeDoc("Closeout Distinctness Spec");
    const flagger = await upsertUserByEmail("spec535-distinct@example.com");
    await setSensitive(memexId, docId, { actorUserId: flagger.id, channel: "mcp" });

    const [row] = await db.select().from(documents).where(eq(documents.id, docId));
    const out = formatFullDocState({ ...row, sections: [] } as never, [], []);

    // The header is a run of `Key: value` lines. The warning must not read as one
    // more of them — that is the camouflage failure spec-240 dec-1 recorded, and
    // it is why dec-3 chose a delimited block over a `Sensitive: true` line.
    expect(out).not.toMatch(/^Sensitive: /m);
    const marked = out.split("\n").filter((l) => l.includes("⚠"));
    expect(marked.length).toBeGreaterThan(1);
    // The web half of this AC is pinned by SensitiveBanner.test.tsx (the word
    // survives with every class stripped) and by journey-70 (the banner is not
    // inside the byline row on the assembled page).
  });
});
