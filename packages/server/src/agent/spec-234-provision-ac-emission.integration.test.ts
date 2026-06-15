// spec-234 t-2 — the provision_ac_emission MCP tool, exercised through the real MCP
// server path (createMcpServer → registered handler → resolveRef + mint + guidance).
// Pins: one call returns a usable key AND the integration guidance; the key actually
// emits; the guidance is the shared bootstrap source (not a copy); member-gated; and
// the response never tells the agent to persist the key.

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
  acs,
  decisions,
  users,
  memexEmissionKeys,
  testEvents,
} from "../db/schema.js";
import { createMcpServer } from "../mcp/tools.js";
import { app } from "../app.js";
import { fetchTopic } from "../services/guidance.js";
import { toolManifest } from "@memex/shared";

const M = "mindset-prod/memex-building-itself/specs/spec-234/acs";
const AC_1 = `${M}/ac-1`; // single MCP call yields a usable key, no human/Settings
const AC_2 = `${M}/ac-2`; // returns markdown guidance to wire emission natively
const AC_3 = `${M}/ac-3`; // multiple suites covered
const AC_4 = `${M}/ac-4`; // a fresh session re-establishes a working key
const AC_6 = `${M}/ac-6`; // no install step to begin emitting
const AC_13 = `${M}/ac-13`; // registered single tool (manifest + specs)
const AC_14 = `${M}/ac-14`; // single ref → key + guidance in one response
const AC_16 = `${M}/ac-16`; // guidance from the shared bootstrap source, not duplicated
const AC_17 = `${M}/ac-17`; // member-level auth; created_by_user_id recorded
const AC_18 = `${M}/ac-18`; // no persist-to-disk instruction
const AC_19 = `${M}/ac-19`; // no separate package-install gateway

const created = {
  users: [] as string[],
  memexes: [] as string[],
  docs: [] as string[],
  acUids: [] as string[],
};

afterAll(async () => {
  if (created.acUids.length)
    await db.delete(testEvents).where(inArray(testEvents.acUid, created.acUids)).catch(() => {});
  if (created.memexes.length)
    await db.delete(memexEmissionKeys).where(inArray(memexEmissionKeys.memexId, created.memexes)).catch(() => {});
  if (created.docs.length) {
    await db.delete(acs).where(inArray(acs.briefId, created.docs)).catch(() => {});
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
  const [u] = await db.insert(users).values({ email: `${sub}@memex.ai` } as typeof users.$inferInsert).returning();
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
function registryFor(userId: string) {
  const server = createMcpServer(userId);
  return (server as unknown as {
    _registeredTools: Record<string, { handler: (a: Record<string, unknown>, e: unknown) => Promise<ToolResult> | ToolResult }>;
  })._registeredTools;
}
async function callToolRaw(userId: string, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const tool = registryFor(userId)[name];
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return tool.handler(args, {} as unknown);
}
async function callTool(userId: string, name: string, args: Record<string, unknown>): Promise<string> {
  const res = await callToolRaw(userId, name, args);
  return res.content.map((c) => c.text).join("\n");
}

function extractKey(out: string): string {
  const m = out.match(/MEMEX_EMIT_KEY=(mxk_[A-Za-z0-9_-]+)/);
  if (!m) throw new Error(`no key in tool output:\n${out}`);
  return m[1]!;
}

async function postEvent(acUid: string, bearer: string): Promise<Response> {
  return app.request("/api/test-events", {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "memex.ai", Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ ac_uid: acUid, status: "pass", test_identifier: "t::x", duration_ms: 1 }),
  });
}

describe("spec-234 — provision_ac_emission MCP tool", () => {
  let actor: Awaited<ReturnType<typeof setupActor>>;
  let ref: string;
  let handle: string;
  let out: string;

  beforeAll(async () => {
    actor = await setupActor("provision");
    const docOut = await callTool(actor.user.id, "create_doc", {
      memex: `${actor.nsSlug}/main`,
      title: "Provision emission probe",
      purpose: "Probe.",
    });
    handle = docOut.match(/specs\/(spec-\d+)/)![1]!;
    const doc = await db.query.documents.findFirst({ where: eq(documents.handle, handle) });
    created.docs.push(doc!.id);
    ref = `${actor.nsSlug}/main/specs/${handle}`;
    out = await callTool(actor.user.id, "provision_ac_emission", { ref });
  });

  it("is a single registered tool in the manifest [ac-13]", () => {
    tagAc(AC_13);
    const entries = toolManifest.filter((e) => e.name === "provision_ac_emission");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.readOnlyHint).toBe(false);
    // and it is reachable through the live MCP registry
    expect(registryFor(actor.user.id)["provision_ac_emission"]).toBeDefined();
  });

  it("returns a key AND the integration guidance in one response [ac-14]", () => {
    tagAc(AC_14);
    expect(out).toMatch(/MEMEX_EMIT_KEY=mxk_/);
    expect(out).toMatch(/Wire emission into/i);
    expect(out).toContain(handle); // the response names the Spec it scoped to
  });

  it("renders the guidance from the shared ac-emission-bootstrap source, not a copy [ac-16]", async () => {
    tagAc(AC_16);
    const bootstrap = await fetchTopic("ac-emission-bootstrap");
    // The full shared body is embedded verbatim — same single source get_information serves.
    expect(out).toContain(bootstrap.body);
  });

  it("guidance tells the agent to detect the runner, author natively, cover every suite, no install [ac-2][ac-3][ac-6][ac-19]", () => {
    tagAc(AC_2);
    tagAc(AC_3);
    tagAc(AC_6);
    tagAc(AC_19);
    expect(out).toMatch(/detect the test runner/i);
    expect(out).toMatch(/hand-roll/i); // native authoring when no official helper
    expect(out).toMatch(/every\s+suite|multiple suites/i);
    expect(out).toMatch(/no package install|no install/i);
  });

  it("never instructs persisting the key to disk [ac-18]", () => {
    tagAc(AC_18);
    expect(out).toMatch(/do not (save|persist|write)/i);
    expect(out).toMatch(/this session only/i);
    // Must not tell the agent to put it in a file.
    expect(out).not.toMatch(/add (it )?to your \.env|write it to \.env\b/i);
  });

  it("records the minting member and is gated to members [ac-17]", async () => {
    tagAc(AC_17);
    const rows = await db.query.memexEmissionKeys.findMany({
      where: eq(memexEmissionKeys.memexId, actor.memexId),
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.createdByUserId === actor.user.id)).toBe(true);

    // A non-member cannot provision for this Memex's Spec (membership gate, no elevated scope).
    const stranger = await setupActor("stranger");
    const denied = await callToolRaw(stranger.user.id, "provision_ac_emission", { ref });
    expect(denied.isError).toBe(true);
  });

  it("the provisioned key actually emits for this Spec, and a fresh call yields another working key [ac-1][ac-4]", async () => {
    tagAc(AC_1);
    tagAc(AC_4);
    const acUid = `${actor.nsSlug}/main/specs/${handle}/acs/ac-1`;
    created.acUids.push(acUid);

    const key1 = extractKey(out);
    expect((await postEvent(acUid, key1)).status).toBe(201);

    // Fresh session: a new provision call returns a different, also-working key — no human
    // re-finding, no persisted secret needed.
    const out2 = await callTool(actor.user.id, "provision_ac_emission", { ref });
    const key2 = extractKey(out2);
    expect(key2).not.toBe(key1);
    expect((await postEvent(acUid, key2)).status).toBe(201);
  });
});
