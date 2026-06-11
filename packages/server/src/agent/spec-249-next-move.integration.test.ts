// spec-249 — get_doc PUSHES a live next-move line onto a cold agent.
//
// The cold picker-upper is definitionally the agent that doesn't know it is
// missing orientation, so it never sets a flag. get_doc is the one call it is
// guaranteed to make, so the next-move line rides the TERSE get_doc footer
// automatically. These tests exercise the real seat + the real MCP tool path.
//
//   ac-1  the terse get_doc footer ends with one synthesized line (phase +
//         headline state + the single next action).
//   ac-3  the verbose pointer rides the line only when material hidden state
//         exists; a trivial spec carries no standing "try verbose" nag.
//   ac-4  the line is composed in the single seat (composeGuidanceEnvelope) — a
//         source-text guard pins craftNextMoveLine to that one author.
//   ac-5  no new flag/tool — verbose still means only "full markdown state", the
//         line is terse-only, and the why-Memex framing is not duplicated here.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import {
  users,
  namespaces,
  orgs,
  orgMemberships,
  memexes,
  documents,
  decisions,
  tasks,
  acs,
} from "../db/schema.js";
import { createDocDraft } from "../services/documents.js";
import { createDecision, resolveDecision } from "../services/decisions.js";
import { createAc } from "../services/acs.js";
import { createMcpServer } from "../mcp/tools.js";
import { composeGuidanceEnvelope, type ToolCtx } from "./tool-specs.js";
import { splitToolResult } from "../mcp/footer-delimiter.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-249/acs/ac-${n}`;

const created = { users: [] as string[], memexes: [] as string[], docs: [] as string[] };
let memexId: string;
let nsSlug: string;
let userId: string;

function terseGetDocCtx(): ToolCtx {
  // The terse get_doc path: verbose:false, toolName 'get_doc'. The seat reads
  // verbose + toolName + userId on this path; workspaceUrl is only hit on verbose.
  return {
    userId,
    verbose: false,
    channel: "mcp",
    toolName: "get_doc",
    workspaceUrl: async () => "",
  } as unknown as ToolCtx;
}

interface ToolResult { isError?: boolean; content: Array<{ type: string; text: string }> }
async function callGetDoc(ref: string, verbose: boolean): Promise<string> {
  const server = createMcpServer(userId);
  const registry = (
    server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (a: Record<string, unknown>, e: unknown) => Promise<ToolResult> | ToolResult }
      >;
    }
  )._registeredTools;
  const res = await registry.get_doc.handler({ ref, verbose }, {} as unknown);
  return res.content.map((c) => c.text).join("\n");
}

async function freshSpec(
  title: string,
  status: "specify" | "build" | "verify",
): Promise<{ id: string; ref: string; handle: string }> {
  const doc = await createDocDraft(memexId, title, "Purpose.", "spec");
  created.docs.push(doc.id);
  await db.update(documents).set({ status }).where(eq(documents.id, doc.id));
  return { id: doc.id, ref: `${nsSlug}/main/specs/${doc.handle}`, handle: doc.handle };
}

beforeAll(async () => {
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const [u] = await db
    .insert(users)
    .values({ email: `nm-${tag}@memex.ai`, name: "Picker Upper" } as typeof users.$inferInsert)
    .returning();
  userId = u.id;
  created.users.push(u.id);
  const [ns] = await db.insert(namespaces).values({ slug: `nm-${tag}`, kind: "org" }).returning();
  nsSlug = ns.slug;
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `T ${tag}` }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [m] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: `T ${tag}` }).returning();
  memexId = m.id;
  created.memexes.push(m.id);
  await db.insert(orgMemberships).values({ userId: u.id, orgId: org.id, role: "administrator" });
});

afterAll(async () => {
  if (created.docs.length) {
    await db.delete(acs).where(inArray(acs.briefId, created.docs)).catch(() => {});
    await db.delete(tasks).where(inArray(tasks.docId, created.docs)).catch(() => {});
    await db.delete(decisions).where(inArray(decisions.docId, created.docs)).catch(() => {});
    await db.delete(documents).where(inArray(documents.id, created.docs)).catch(() => {});
  }
  if (created.memexes.length)
    await db.delete(memexes).where(inArray(memexes.id, created.memexes)).catch(() => {});
  if (created.users.length)
    await db.delete(users).where(inArray(users.id, created.users)).catch(() => {});
});

describe("ac-1 — the terse get_doc footer ends with the synthesized next-move line", () => {
  it("synthesizes phase + state + next action with an open decision", async () => {
    tagAc(AC(1));
    const spec = await freshSpec("Open decision spec", "specify");
    const dec = await createDecision(memexId, spec.id, "A fork to settle.");

    const env = await composeGuidanceEnvelope(memexId, spec.id, terseGetDocCtx());
    const footer = env.footer ?? "";
    expect(footer).toContain(
      `${spec.handle} · specify · 1 open decision (dec-${dec.seq}), 0 implementation ACs. ` +
        `Next: resolve dec-${dec.seq}, then give it an implementation AC.`,
    );
  });

  it("rides the REAL terse get_doc response, after the footer delimiter", async () => {
    tagAc(AC(1));
    const spec = await freshSpec("Real terse get_doc spec", "specify");
    await createDecision(memexId, spec.id, "Another fork.");

    const out = await callGetDoc(spec.ref, false);
    const { footer } = splitToolResult(out);
    expect(footer ?? "").toMatch(
      new RegExp(`${spec.handle} · specify · .*\\. Next: resolve dec-\\d+`),
    );
  });
});

describe("ac-3 — the verbose pointer is live, gated on material hidden state", () => {
  it("points to verbose when an open decision hides text", async () => {
    tagAc(AC(3));
    const spec = await freshSpec("Hidden-state spec", "specify");
    await createDecision(memexId, spec.id, "Hidden fork.");

    const env = await composeGuidanceEnvelope(memexId, spec.id, terseGetDocCtx());
    expect(env.footer ?? "").toContain("(get_doc verbose for the full decision/task text.)");
  });

  it("omits the pointer for a trivial spec — no decisions, tasks, or untested ACs", async () => {
    tagAc(AC(3));
    const spec = await freshSpec("Trivial spec", "specify");

    const env = await composeGuidanceEnvelope(memexId, spec.id, terseGetDocCtx());
    const footer = env.footer ?? "";
    // The next-move line is still present (get_doc always ends with one)...
    expect(footer).toContain(`${spec.handle} · specify ·`);
    // ...but it carries no verbose pointer: nothing hidden is worth a second call.
    expect(footer).not.toContain("get_doc verbose for the full");
  });
});

describe("ac-5 — no new flag/tool; verbose stays 'full markdown state' only", () => {
  it("the next-move line is TERSE-only — verbose get_doc does not synthesize it", async () => {
    tagAc(AC(5));
    const spec = await freshSpec("Verbose-vs-terse spec", "specify");
    await createDecision(memexId, spec.id, "Fork for the verbose check.");

    const terse = splitToolResult(await callGetDoc(spec.ref, false)).footer ?? "";
    const verbose = splitToolResult(await callGetDoc(spec.ref, true)).footer ?? "";

    const nextMoveLine = new RegExp(`${spec.handle} · specify · .*\\. Next: `);
    expect(terse).toMatch(nextMoveLine);
    expect(verbose).not.toMatch(nextMoveLine);
  });

  it("the why-Memex onboarding framing is NOT duplicated onto get_doc", async () => {
    tagAc(AC(5));
    const spec = await freshSpec("No why-memex dup spec", "specify");
    await createDecision(memexId, spec.id, "Fork.");

    const env = await composeGuidanceEnvelope(memexId, spec.id, terseGetDocCtx());
    const footer = env.footer ?? "";
    expect(footer).not.toContain("Why Memex and not loose markdown");
    expect(footer).not.toContain("get_information(topic='why-memex')");
  });
});

describe("ac-4 — the line is composed in the single seat (source guard)", () => {
  const SRC = readFileSync(join(__dirname, "tool-specs.ts"), "utf-8");

  it("craftNextMoveLine is referenced only inside composeGuidanceEnvelope (or its own def)", () => {
    tagAc(AC(4));
    // composeGuidanceEnvelope's body spans from its header to the next top-level
    // construct (the spec-122 ACTIVITY block comment placed immediately after it).
    const seatStart = SRC.indexOf("export async function composeGuidanceEnvelope(");
    const seatEnd = SRC.indexOf(
      "// spec-122 dec-7 (ac-23 / ac-24) — compose the get_doc ACTIVITY",
      seatStart,
    );
    expect(seatStart).toBeGreaterThan(-1);
    expect(seatEnd).toBeGreaterThan(seatStart);

    const call = "craftNextMoveLine(";
    const defLine = /async function craftNextMoveLine\(/;
    const offenders: number[] = [];
    let idx = SRC.indexOf(call);
    while (idx !== -1) {
      const withinSeat = idx >= seatStart && idx < seatEnd;
      const lineStart = SRC.lastIndexOf("\n", idx) + 1;
      const lineEndRaw = SRC.indexOf("\n", idx);
      const lineEnd = lineEndRaw === -1 ? SRC.length : lineEndRaw;
      const isOwnDecl = defLine.test(SRC.slice(lineStart, lineEnd));
      if (!withinSeat && !isOwnDecl) offenders.push(SRC.slice(0, idx).split("\n").length);
      idx = SRC.indexOf(call, idx + 1);
    }
    expect(
      offenders,
      `craftNextMoveLine used outside composeGuidanceEnvelope at line(s) ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});

describe("ac-1 — the line tracks build and verify state too", () => {
  it("build: an implementation AC that is untested shows up with the test push", async () => {
    tagAc(AC(1));
    const spec = await freshSpec("Build-phase spec", "build");
    const dec = await createDecision(memexId, spec.id, "Resolved fork.");
    await resolveDecision(memexId, dec.id, "Chosen.");
    const implAc = await createAc({
      memexId,
      briefId: spec.id,
      kind: "implementation",
      statement: "The thing does the thing.",
      parent: { kind: "decision", id: dec.id },
    });

    const env = await composeGuidanceEnvelope(memexId, spec.id, terseGetDocCtx());
    const footer = env.footer ?? "";
    expect(footer).toContain(
      `${spec.handle} · build · 0 incomplete tasks, 1 untested AC (ac-${implAc.seq}). ` +
        `Next: break the narrative into tasks (create_task).`,
    );
    // an untested AC is material hidden state → the pointer rides the line.
    expect(footer).toContain("(get_doc verbose for the full decision/task text.)");
  });
});
