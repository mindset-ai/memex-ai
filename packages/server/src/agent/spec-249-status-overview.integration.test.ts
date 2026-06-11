// spec-249 — the status overview reaches a cold picker-upper no matter HOW it
// reads the spec. Exercised end-to-end through the real MCP tool registry (so the
// choke point composeGuidanceEnvelope → footer wiring is covered for real).
//
// The motivating failure: the first cut rode only terse get_doc, so across 8
// reads in the thread that built it the line rendered 0 times — the agent read
// get_doc once with verbose:true (suppressed) and otherwise used list_acs /
// assess_spec. So these tests assert the overview on EVERY read surface and BOTH
// flags, and assert it does NOT leak onto mutations.
//
//   ac-2  rides get_doc, list_acs, assess_spec — terse AND verbose, never gated on verbose.
//   ac-1  carries the full live census on a real read.
//   ac-6  composed in the single seat (source guard on craftStatusOverview).
//   ac-7  no new tool/flag: verbose still returns full state; read-path only
//         (mutation footers untouched); no why-Memex framing duplicated.

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
import { createDecision } from "../services/decisions.js";
import { createTask } from "../services/tasks.js";
import { createAc } from "../services/acs.js";
import { createMcpServer } from "../mcp/tools.js";
import { splitToolResult } from "../mcp/footer-delimiter.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-249/acs/ac-${n}`;

const created = { users: [] as string[], memexes: [] as string[], docs: [] as string[] };
let memexId: string;
let nsSlug: string;
let userId: string;
let specRef: string;
let specHandle: string;

interface ToolResult { isError?: boolean; content: Array<{ type: string; text: string }> }
async function callTool(name: string, args: Record<string, unknown>): Promise<string> {
  const server = createMcpServer(userId);
  const registry = (
    server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (a: Record<string, unknown>, e: unknown) => Promise<ToolResult> | ToolResult }
      >;
    }
  )._registeredTools;
  const res = await registry[name].handler(args, {} as unknown);
  return res.content.map((c) => c.text).join("\n");
}

const footerOf = (out: string): string => splitToolResult(out).footer ?? "";

beforeAll(async () => {
  const tag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const [u] = await db
    .insert(users)
    .values({ email: `so-${tag}@memex.ai`, name: "Picker Upper" } as typeof users.$inferInsert)
    .returning();
  userId = u.id;
  created.users.push(u.id);
  const [ns] = await db.insert(namespaces).values({ slug: `so-${tag}`, kind: "org" }).returning();
  nsSlug = ns.slug;
  const [org] = await db.insert(orgs).values({ namespaceId: ns.id, name: `T ${tag}` }).returning();
  await db.update(namespaces).set({ ownerOrgId: org.id }).where(eq(namespaces.id, ns.id));
  const [m] = await db.insert(memexes).values({ namespaceId: ns.id, slug: "main", name: `T ${tag}` }).returning();
  memexId = m.id;
  created.memexes.push(m.id);
  await db.insert(orgMemberships).values({ userId: u.id, orgId: org.id, role: "administrator" });

  // A build-phase spec with a known census: 1 open decision, 1 incomplete task,
  // 1 untested scope AC → "decisions: 1 (1 unresolved) · tasks: 1 (1 incomplete)
  // · ACs: 1 (1 untested, 0 failing) · Next: complete t-1".
  const doc = await createDocDraft(memexId, "Overview surface spec", "Purpose of the spec.", "spec");
  created.docs.push(doc.id);
  specHandle = doc.handle;
  specRef = `${nsSlug}/main/specs/${doc.handle}`;
  await db.update(documents).set({ status: "build" }).where(eq(documents.id, doc.id));
  await createDecision(memexId, doc.id, "An open fork.");
  await createTask(memexId, doc.id, "A task to complete.", "Body.");
  await createAc({ memexId, briefId: doc.id, kind: "scope", statement: "An observable outcome." });
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

describe("ac-2 — the overview rides every read surface, on both terse and verbose", () => {
  it("appears on get_doc, list_acs, and assess_spec — terse AND verbose", async () => {
    tagAc(AC(2));
    const reads: Array<[string, Record<string, unknown>]> = [
      ["get_doc", { ref: specRef }],
      ["list_acs", { ref: specRef }],
      ["assess_spec", { ref: specRef, mode: "comments" }],
    ];
    const signature = new RegExp(
      `${specHandle} · build · decisions: \\d+ \\(\\d+ unresolved\\) · tasks: .* · ACs: .* · Next: `,
    );
    for (const [tool, base] of reads) {
      for (const verbose of [false, true]) {
        const footer = footerOf(await callTool(tool, { ...base, verbose }));
        expect(footer, `${tool} verbose=${verbose} should carry the overview`).toMatch(signature);
      }
    }
  });
});

describe("ac-1 — the overview carries the full live census on a real read", () => {
  it("get_doc footer shows the exact census and next action for this spec's state", async () => {
    tagAc(AC(1));
    const footer = footerOf(await callTool("get_doc", { ref: specRef, verbose: false }));
    expect(footer).toContain(
      `${specHandle} · build · decisions: 1 (1 unresolved) · tasks: 1 (1 incomplete) · ` +
        `ACs: 1 (1 untested, 0 failing) · Next: complete t-1.`,
    );
  });
});

describe("ac-7 — no new tool/flag; verbose stays full state; read-path only", () => {
  it("verbose still returns the full doc body AND the overview (verbose ≠ the trigger)", async () => {
    tagAc(AC(7));
    const verbose = await callTool("get_doc", { ref: specRef, verbose: true });
    // Full markdown state is still there (the section body)...
    expect(verbose).toContain("Purpose of the spec.");
    // ...and so is the overview, in the footer.
    expect(footerOf(verbose)).toContain(`${specHandle} · build · decisions:`);
  });

  it("the why-Memex onboarding framing is not duplicated onto the read surfaces", async () => {
    tagAc(AC(7));
    const footer = footerOf(await callTool("get_doc", { ref: specRef, verbose: false }));
    expect(footer).not.toContain("Why Memex and not loose markdown");
    expect(footer).not.toContain("get_information(topic='why-memex')");
  });

  it("a MUTATION does not carry the overview — read-path only", async () => {
    tagAc(AC(7));
    // create_decision is a mutation; its footer is its own result-reporting, not
    // the status overview census.
    const footer = footerOf(
      await callTool("create_decision", { ref: specRef, title: "A fork created via MCP." }),
    );
    expect(footer).not.toMatch(/· decisions: \d+ \(\d+ unresolved\) · tasks:/);
  });
});

describe("ac-6 — the overview is composed in the single seat (source guard)", () => {
  const SRC = readFileSync(join(__dirname, "tool-specs.ts"), "utf-8");

  it("craftStatusOverview is referenced only inside composeGuidanceEnvelope (or its own def)", () => {
    tagAc(AC(6));
    const seatStart = SRC.indexOf("export async function composeGuidanceEnvelope(");
    const seatEnd = SRC.indexOf(
      "// spec-122 dec-7 (ac-23 / ac-24) — compose the get_doc ACTIVITY",
      seatStart,
    );
    expect(seatStart).toBeGreaterThan(-1);
    expect(seatEnd).toBeGreaterThan(seatStart);

    const call = "craftStatusOverview(";
    const defLine = /async function craftStatusOverview\(/;
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
      `craftStatusOverview used outside composeGuidanceEnvelope at line(s) ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
