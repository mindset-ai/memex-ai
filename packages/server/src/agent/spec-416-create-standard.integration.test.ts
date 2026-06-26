// spec-416 (dec-1 / dec-2): the standards agent gains a dedicated `create_standard`
// tool so it can author a brand-new standard from scratch — without a `docType`
// param, so the spec-389 scope wall holds by construction (it can mint standards
// and nothing else new).
//
// This suite verifies dec-2's two clauses:
//   - ac-6 (a): invoking `create_standard` runs the SAME create path create_doc
//     uses with docType:'standard' — it mints a `std-N` standard row. The
//     render_confirmation gate is the agent-loop's propose-then-confirm step that
//     precedes this handler (the handler is what fires AFTER the user confirms);
//     it is a UI tool, never executed server-side, so what we assert here is that
//     the handler — the post-confirmation write — creates a standard and nothing
//     else.
//   - ac-6 (b): the STANDARDS_AGENT_GUIDANCE prose names standard creation while
//     still instructing handoff for out-of-lane asks.

import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  memexes,
  namespaces,
  orgs,
  orgMemberships,
  documents,
  users,
} from "../db/schema.js";
import { executeServerTool } from "./tools.js";
import { STANDARDS_AGENT_GUIDANCE } from "@memex/shared";

const SPEC416 = "mindset-prod/memex-building-itself/specs/spec-416";
const AC6 = `${SPEC416}/acs/ac-6`;
// ac-4 (scope): the standards-agent guidance/prompt is updated to state it can
// create new standards while still instructing handoff for out-of-lane asks.
const AC4 = `${SPEC416}/acs/ac-4`;
// ac-2 (scope): creation goes through the agent's render_confirmation gate — no
// standard is minted without explicit user confirmation. render_confirmation is
// a display-only UI tool (never executed server-side), so the verifiable artifact
// is that the guidance instructs the agent to confirm BEFORE creating.
const AC2 = `${SPEC416}/acs/ac-2`;

const created = { users: [] as string[], memexes: [] as string[], docs: [] as string[] };

afterAll(async () => {
  if (created.docs.length)
    await db.delete(documents).where(inArray(documents.id, created.docs)).catch(() => {});
  if (created.memexes.length)
    await db.delete(memexes).where(inArray(memexes.id, created.memexes)).catch(() => {});
  if (created.users.length)
    await db.delete(users).where(inArray(users.id, created.users)).catch(() => {});
});

async function setupActor(prefix: string) {
  const sub = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
  const [u] = await db.insert(users).values({ email: `${sub}@memex.ai` } as any).returning();
  created.users.push(u.id);
  const [ns] = await db.insert(namespaces).values({ slug: sub, kind: "org" }).returning();
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `Test ${sub}` }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [a] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: `Test ${sub}` }).returning();
  created.memexes.push(a.id);
  await db.insert(orgMemberships).values({ userId: u.id, orgId: org.id, role: "administrator" });
  return { user: u, memexId: a.id, nsSlug: ns.slug };
}

describe("spec-416 dec-1/dec-2: create_standard mints a standard via the gated create path (ac-6)", () => {
  it("invoking create_standard creates a `standard` doc with a std-N handle", async () => {
    tagAc(AC6);
    const actor = await setupActor("create-standard");

    const out = await executeServerTool(
      actor.memexId,
      "create_standard",
      {
        memex: `${actor.nsSlug}/main`,
        title: "Always validate input at the boundary",
        purpose: "Rule: every external input is validated before it reaches a service.",
      },
      actor.user.id,
    );

    // The handler reports a std-N ref (the same `ref:` form create_doc emits),
    // proving the create path ran and minted a standard.
    const handle = out.match(/standards\/(std-\d+)/)?.[1];
    expect(handle, `create_standard should report a std-N ref; got: ${out}`).toBeTruthy();

    const doc = await db.query.documents.findFirst({
      where: eq(documents.handle, handle!),
    });
    created.docs.push(doc!.id);

    // It created a STANDARD — not a spec / document / execution_plan. The tool
    // has no docType param, so this is the only doc type it can ever produce.
    expect(doc!.docType).toBe("standard");
    expect(doc!.handle).toMatch(/^std-\d+$/);
    expect(doc!.memexId).toBe(actor.memexId);
    expect(doc!.title).toBe("Always validate input at the boundary");
  });

  it("the tool has no docType input — it cannot express any other doc type (scope wall by construction)", async () => {
    tagAc(AC6);
    const { toolSpecs } = await import("./tool-specs.js");
    const spec = toolSpecs.find((s) => s.name === "create_standard");
    expect(spec, "create_standard must be a registered ToolSpec").toBeTruthy();
    // The schema must NOT carry a docType field — the whole point of dec-1.
    expect(Object.keys(spec!.schema)).not.toContain("docType");
  });
});

describe("spec-416 dec-2: standards-agent guidance names standard creation (ac-6)", () => {
  it("STANDARDS_AGENT_GUIDANCE tells the agent it can CREATE a new standard", () => {
    tagAc(AC6);
    // The same prose update IS the ac-4 outcome: guidance names creation AND
    // still instructs handoff for out-of-lane asks.
    tagAc(AC4);
    const text = STANDARDS_AGENT_GUIDANCE.text;
    // The guidance names the create_standard verb and the create capability.
    expect(text).toContain("create_standard");
    expect(text).toMatch(/create a (brand-)?new standard|create a standard/i);
    // It still instructs handoff for genuinely out-of-lane asks.
    expect(text).toContain("render_handoff");
    expect(text).toMatch(/new Spec|Issue|code/);
  });

  it("ac-2: guidance gates creation behind render_confirmation — confirm BEFORE creating", () => {
    tagAc(AC2);
    const text = STANDARDS_AGENT_GUIDANCE.text;
    // Every mutation — creation included — is proposed through render_confirmation
    // first; never create until the user confirms.
    expect(text).toContain("render_confirmation");
    expect(text).toMatch(/creation included|never create or edit until the user confirms/i);
  });
});
