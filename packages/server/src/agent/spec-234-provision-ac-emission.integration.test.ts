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
const AC_6 = `${M}/ac-6`; // an unshipped stack can emit with nothing installed
const AC_13 = `${M}/ac-13`; // guidance: detect runner, prefer helper when present, else hand-roll
const AC_14 = `${M}/ac-14`; // registered single tool (manifest + tool-specs)
const AC_15 = `${M}/ac-15`; // single ref → key + guidance in one response
const AC_16 = `${M}/ac-16`; // guidance from the shared bootstrap source, not duplicated
const AC_17 = `${M}/ac-17`; // no repo file written; no persist-to-disk instruction
const AC_18 = `${M}/ac-18`; // member-level auth; created_by_user_id recorded
const AC_19 = `${M}/ac-19`; // agent keys named `agent · <spec> · <date>`

// spec-533 issue-1 — the tags above were SCRAMBLED against Memex: the manifest
// test carried ac-13 (whose real subject is the guidance), the key+guidance test
// carried ac-14 (the manifest AC), ac-17/ac-18 were swapped, and ac-19 — whose
// real subject is emission-key NAMING — was tagged on a test that asserts four
// guidance regexes and nothing about names. spec-234 read 21/21 verified with
// five ACs green off tests that checked a different criterion, and the naming
// behaviour had no coverage at all. Re-pointed here; spec-234 stays `done` and
// is not retro-edited.

const created = {
  users: [] as string[],
  memexes: [] as string[],
  docs: [] as string[],
  acUids: [] as string[],
};

afterAll(async () => {
  if (created.acUids.length)
    await db.delete(testEvents).where(inArray(testEvents.subjectRef, created.acUids)).catch(() => {});
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

async function postEvent(subjectRef: string, bearer: string): Promise<Response> {
  return app.request("/api/test-events", {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: "memex.ai", Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ ac_uid: subjectRef, status: "pass", test_identifier: "t::x", duration_ms: 1 }),
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

  it("is a single registered tool in the manifest [ac-14]", () => {
    tagAc(AC_14);
    const entries = toolManifest.filter((e) => e.name === "provision_ac_emission");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.readOnlyHint).toBe(false);
    // and it is reachable through the live MCP registry
    expect(registryFor(actor.user.id)["provision_ac_emission"]).toBeDefined();
  });

  it("returns a key AND the integration guidance in one response [ac-15]", () => {
    tagAc(AC_15);
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

  it("guidance tells the agent to detect the runner, install the helper where one exists, else hand-roll, across every suite [ac-2][ac-3][ac-13]", () => {
    tagAc(AC_2);
    tagAc(AC_3);
    tagAc(AC_13);
    expect(out).toMatch(/detect the test runner/i);
    expect(out).toMatch(/hand-roll/i); // native authoring when no official helper
    expect(out).toMatch(/every\s+suite|multiple suites/i);
    // spec-533 dec-5 SUPERSEDES spec-234 dec-2 for covered stacks: the old
    // assertion here was /no package install|no install/, which is exactly the
    // framing that sent a Vitest repo to hand-roll 80 lines it did not need.
    // What replaces it is the conditional rule — and the table that makes the
    // condition evaluable, which the agent could never see before (dec-1).
    expect(out).toMatch(/expected path/i);
    expect(out).toMatch(/npm install --save-dev @memex-ai-ac\/vitest/);
    expect(out).not.toMatch(/no package install/i);
  });

  it("still lets a stack with no official helper emit with nothing installed [ac-6]", () => {
    tagAc(AC_6);
    // spec-234's load-bearing property, deliberately preserved by dec-5: the
    // supersession is scoped to stacks a helper COVERS. Nobody is stranded —
    // the full hand-roll protocol is still served, to every repo.
    expect(out).toMatch(/every other stack/i);
    expect(out).toMatch(/hand-roll it with the protocol below/i);
    // The behavioural contract itself must still be there to follow.
    expect(out).toMatch(/api\/test-events\/batch/);
    expect(out).toMatch(/X-Memex-Warning/);
  });

  it("never instructs persisting the key to disk [ac-17]", () => {
    tagAc(AC_17);
    expect(out).toMatch(/do not (save|persist|write)/i);
    expect(out).toMatch(/this session only/i);
    // Must not tell the agent to put it in a file.
    expect(out).not.toMatch(/add (it )?to your \.env|write it to \.env\b/i);
  });

  it("records the minting member and is gated to members [ac-18]", async () => {
    tagAc(AC_18);
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

  it("names agent-provisioned keys so a human can tell them from a CI key [ac-19]", async () => {
    tagAc(AC_19);
    // spec-533 issue-1: this behaviour was claimed verified and tested NOWHERE.
    // ac-19's only test asserted four guidance regexes and nothing about names,
    // so the naming contract — the primary human audit signal in
    // Settings → Emission Keys — was green on unrelated evidence.
    const rows = await db.query.memexEmissionKeys.findMany({
      where: eq(memexEmissionKeys.memexId, actor.memexId),
    });
    expect(rows.length).toBeGreaterThan(0);
    // `agent · <spec> · <date>`: marks the key as agent/ephemeral and ties it
    // to its origin, distinguishable from a human-chosen CI key name.
    const agentKeys = rows.filter((r) => r.name.startsWith("agent"));
    expect(agentKeys.length).toBeGreaterThan(0);
    for (const k of agentKeys) {
      expect(k.name).toContain(handle); // the Spec it was scoped to
      expect(k.name).toMatch(/\d{4}-\d{2}-\d{2}/); // and when it was minted
    }
  });

  it("the provisioned key actually emits for this Spec, and a fresh call yields another working key [ac-1][ac-4]", async () => {
    tagAc(AC_1);
    tagAc(AC_4);
    const subjectRef = `${actor.nsSlug}/main/specs/${handle}/acs/ac-1`;
    created.acUids.push(subjectRef);

    const key1 = extractKey(out);
    expect((await postEvent(subjectRef, key1)).status).toBe(201);

    // Fresh session: a new provision call returns a different, also-working key — no human
    // re-finding, no persisted secret needed.
    const out2 = await callTool(actor.user.id, "provision_ac_emission", { ref });
    const key2 = extractKey(out2);
    expect(key2).not.toBe(key1);
    expect((await postEvent(subjectRef, key2)).status).toBe(201);
  });
});
