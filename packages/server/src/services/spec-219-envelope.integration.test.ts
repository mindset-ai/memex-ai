// spec-219 ac-6 / ac-7 — the platform guidance is composed as a single ENVELOPE
// by one seat (`composeGuidanceEnvelope`), and the choke point
// (`runToolWithSpecTraffic`) assembles `header + body + FOOTER_DELIMITER + footer`
// — owning the single delimiter and writing it exactly once.
//
// ac-6: the seat returns `{ header?, footer? }` (delimiter-LESS content) and is
//       the sole composer; `formatFullDocState` composes neither.
// ac-7: the assembled response carries the body, then the one delimiter, then the
//       footer — the delimiter is owned by the choke point, not the body.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  memexes,
  namespaces,
  orgs,
  orgMemberships,
  documents,
  decisions,
  tasks,
  users,
} from "../db/schema.js";
import { createMcpServer } from "../mcp/tools.js";
import { createDocDraft } from "./documents.js";
import { composeGuidanceEnvelope } from "../agent/tool-specs.js";
import type { ToolCtx } from "../agent/tool-specs.js";
import { FOOTER_DELIMITER, splitToolResult } from "../mcp/footer-delimiter.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-219/acs/ac-${n}`;

const created = { users: [] as string[], memexes: [] as string[], docs: [] as string[] };

afterAll(async () => {
  if (created.docs.length) {
    await db.delete(tasks).where(inArray(tasks.docId, created.docs)).catch(() => {});
    await db.delete(decisions).where(inArray(decisions.docId, created.docs)).catch(() => {});
    await db.delete(documents).where(inArray(documents.id, created.docs)).catch(() => {});
  }
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

interface ToolResult { isError?: boolean; content: Array<{ type: string; text: string }> }
interface RegisteredToolLike {
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<ToolResult> | ToolResult;
}

async function callTool(
  userId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const server = createMcpServer(userId);
  const registry = (server as unknown as { _registeredTools: Record<string, RegisteredToolLike> })._registeredTools;
  const tool = registry[name];
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return await tool.handler(args, {} as unknown);
}

const textOf = (res: ToolResult) => res.content.map((c) => c.text).join("\n");

async function buildSpec(title: string): Promise<{ id: string; ref: string }> {
  const doc = await createDocDraft(actor.memexId, title, "Purpose.", "spec");
  created.docs.push(doc.id);
  await db.update(documents).set({ status: "build" }).where(eq(documents.id, doc.id));
  return { id: doc.id, ref: `${actor.nsSlug}/main/specs/${doc.handle}` };
}

let actor: Awaited<ReturnType<typeof setupActor>>;
beforeAll(async () => {
  actor = await setupActor("spec219-envelope");
});

describe("ac-6 — the seat composes an ENVELOPE { header?, footer? }, delimiter-less", () => {
  it("composeGuidanceEnvelope returns an object whose footer carries no FOOTER_DELIMITER", async () => {
    tagAc(AC(6));
    const { id } = await buildSpec("Envelope Object Spec");

    // Terse call (verbose:false) — the lean build-loop steer. The seat reads no
    // other ctx field on this path, so a minimal ctx is faithful.
    const env = await composeGuidanceEnvelope(actor.memexId, id, {
      verbose: false,
    } as unknown as ToolCtx);

    // It is an envelope OBJECT, not a raw footer string.
    expect(env).toBeTypeOf("object");
    expect(Array.isArray(env)).toBe(false);
    // Header is a get_doc-verbose concern (centralized in t-2); absent here.
    expect(env.header).toBeUndefined();
    // The footer body is present but DELIMITER-LESS — the choke point owns the
    // single delimiter.
    expect(env.footer).toBeTruthy();
    expect(env.footer).not.toContain(FOOTER_DELIMITER);
    expect(env.footer).toMatch(/BUILD handoff/);
  });

  it("returns an empty envelope for a non-Spec target (nothing to compose)", async () => {
    tagAc(AC(6));
    const doc = await createDocDraft(actor.memexId, "A plain document", "Body.", "document");
    created.docs.push(doc.id);
    const env = await composeGuidanceEnvelope(actor.memexId, doc.id, {
      verbose: false,
    } as unknown as ToolCtx);
    expect(env.header).toBeUndefined();
    expect(env.footer).toBeUndefined();
  });
});

describe("ac-7 — the choke point assembles body + FOOTER_DELIMITER + footer", () => {
  it("a Spec-resolving tool response carries the delimiter exactly once, body before / footer after", async () => {
    tagAc(AC(7));
    const { ref } = await buildSpec("Assembled Order Spec");

    const res = await callTool(actor.user.id, "get_doc", { ref });
    const text = res.content.map((c) => c.text).join("\n");

    // The single delimiter is written exactly once (owned by the choke point).
    expect(text.split(FOOTER_DELIMITER).length - 1).toBe(1);

    const idx = text.indexOf(FOOTER_DELIMITER);
    expect(idx).toBeGreaterThan(0); // real tool output (body) precedes the delimiter

    const { body, footer } = splitToolResult(text);
    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toContain(FOOTER_DELIMITER); // body is delimiter-less
    expect(footer).toMatch(/BUILD handoff/); // footer sits after the delimiter
  });
});

describe("ac-1 — all platform guidance is composed in ONE place, addressed by (tool, phase, live state)", () => {
  it("the envelope is assembled once per response and varies by tool and by phase", async () => {
    tagAc(AC(1));
    const { id, ref } = await buildSpec("One-Place Addressed Spec");
    await callTool(actor.user.id, "create_ac", { ref, kind: "scope", statement: "An outcome." });

    const build = textOf(await callTool(actor.user.id, "get_doc", { ref, verbose: true }));
    // ONE composed envelope (a single delimiter), header above + footer below.
    expect(build.split(FOOTER_DELIMITER).length - 1).toBe(1);
    // Addressed by TOOL: get_doc carries the coverage header …
    expect(build).toContain("**AC coverage:**");
    // … addressed by LIVE STATE (phase): build surfaces the BUILD handoff.
    expect(splitToolResult(build).footer).toMatch(/BUILD handoff/);

    // Addressed by TOOL: list_acs on the same Spec/phase gets no header.
    const list = textOf(await callTool(actor.user.id, "list_acs", { ref, verbose: true }));
    expect(list).not.toContain("**AC coverage:**");

    // Addressed by LIVE STATE: move the phase, the footer changes accordingly.
    await db.update(documents).set({ status: "verify" }).where(eq(documents.id, id));
    const verifyFooter =
      splitToolResult(textOf(await callTool(actor.user.id, "get_doc", { ref, verbose: true }))).footer ?? "";
    expect(verifyFooter).not.toMatch(/BUILD handoff/);
  });
});

describe("ac-10 — the coverage header is verbose + get_doc only, no header delimiter", () => {
  it("verbose get_doc on a Spec with active ACs prepends **AC coverage:** above the body", async () => {
    tagAc(AC(10));
    const { ref } = await buildSpec("Coverage Header Spec");
    await callTool(actor.user.id, "create_ac", {
      ref,
      kind: "scope",
      statement: "A checkable outcome.",
    });

    const res = await callTool(actor.user.id, "get_doc", { ref, verbose: true });
    const text = res.content.map((c) => c.text).join("\n");

    expect(text).toContain("**AC coverage:**");
    // The header sits ABOVE the doc body (before the title) ...
    const hdr = text.indexOf("**AC coverage:**");
    const title = text.indexOf("# Coverage Header Spec");
    expect(hdr).toBeGreaterThanOrEqual(0);
    expect(title).toBeGreaterThan(hdr);
    // ... in the body region (not inside the footer), and carries no delimiter of
    // its own — the only delimiter present is the single footer one.
    const { body } = splitToolResult(text);
    expect(body).toContain("**AC coverage:**");
    expect(text.split(FOOTER_DELIMITER).length - 1).toBe(1);
  });

  it("verbose get_doc on a Spec with NO active ACs emits no coverage header", async () => {
    tagAc(AC(10));
    const { ref } = await buildSpec("No ACs Spec");
    const res = await callTool(actor.user.id, "get_doc", { ref, verbose: true });
    const text = res.content.map((c) => c.text).join("\n");
    expect(text).not.toContain("**AC coverage:**");
  });

  it("the header is get_doc-only: another verbose tool on the same Spec gets no coverage header", async () => {
    tagAc(AC(10));
    const { ref } = await buildSpec("Tool-Gated Header Spec");
    await callTool(actor.user.id, "create_ac", {
      ref,
      kind: "scope",
      statement: "Another outcome.",
    });
    const res = await callTool(actor.user.id, "list_acs", { ref, verbose: true });
    const text = res.content.map((c) => c.text).join("\n");
    expect(text).not.toContain("**AC coverage:**");
  });

  it("the header is verbose-only: terse get_doc emits no coverage header", async () => {
    tagAc(AC(10));
    const { ref } = await buildSpec("Terse No Header Spec");
    await callTool(actor.user.id, "create_ac", {
      ref,
      kind: "scope",
      statement: "Yet another outcome.",
    });
    const res = await callTool(actor.user.id, "get_doc", { ref }); // terse
    const text = res.content.map((c) => c.text).join("\n");
    expect(text).not.toContain("**AC coverage:**");
  });
});
