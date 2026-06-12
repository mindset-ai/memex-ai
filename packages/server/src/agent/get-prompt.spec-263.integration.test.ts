// spec-263 — get_prompt: fetch the phase handoff prompt from inside the coding
// session.
//
// The handlers are exercised through a hand-rolled agent ToolCtx (same contract
// as issue-tools.integration.test.ts) so the assertions land on observable
// behaviour: the tool returns EXACTLY what the web UI's copy-prompt button
// produces (toButtonPrompt over the same scaffold node, same interpolation
// context, same Org appends) — byte-parity is the whole point (dec-1/dec-2).
//
// AC emission: every test that proves an AC calls tagAc('<full canonical ref>').

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  toolManifest,
  BASE_SCAFFOLD,
  HANDOFF_BUTTON_BY_PHASE,
  toButtonPrompt,
  toHandoffEssence,
  GET_PROMPT_PROSE,
  type GuidanceBlock,
} from "@memex/shared";
import { db } from "../db/connection.js";
import { documents, memexes, namespaces } from "../db/schema.js";
import { makeTestMemex } from "../services/test-helpers.js";
import { upsertUserByEmail } from "../services/users.js";
import { createDocDraft, updateDocStatus } from "../services/documents.js";
import { parseRef } from "../services/refs.js";
import { resolveRef as resolveCanonicalRef } from "../services/resolver.js";
import { NotFoundError, ValidationError } from "../types/errors.js";
import { toolSpecs, composeGuidanceEnvelope } from "./tool-specs.js";
import type { ToolCtx } from "./tool-specs.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-263/acs/ac-${n}`;

const createdDocIds: string[] = [];

afterAll(async () => {
  if (createdDocIds.length) {
    await db.delete(documents).where(inArray(documents.id, createdDocIds)).catch(() => {});
  }
});

let memexId: string;
let USER: string;
let slugs: { namespace: string; memex: string };
// The workspace URL the MCP seat resolves — origin/<namespace>/<memex>, the
// exact shape handoffInterpolationContext parses (spec-203 dec-2).
let workspaceUrl: string;

beforeAll(async () => {
  memexId = await makeTestMemex("getprompt");
  const user = await upsertUserByEmail(`getprompt-${Date.now()}@test.example`);
  USER = user.id;
  const mx = await db.query.memexes.findFirst({ where: eq(memexes.id, memexId) });
  if (!mx) throw new Error("test memex not found");
  const ns = await db.query.namespaces.findFirst({
    where: eq(namespaces.id, mx.namespaceId),
  });
  if (!ns) throw new Error("test namespace not found");
  slugs = { namespace: ns.slug, memex: mx.slug };
  workspaceUrl = `https://test.example/${slugs.namespace}/${slugs.memex}`;
});

async function makeSpec(
  title: string,
  status?: string,
): Promise<{ id: string; handle: string; title: string }> {
  const doc = await createDocDraft(memexId, title, `${title} overview`, "spec");
  createdDocIds.push(doc.id);
  if (status && status !== "draft") {
    await updateDocStatus(memexId, doc.id, status);
  }
  return { id: doc.id, handle: doc.handle, title: doc.title };
}

// Hand-rolled agent ctx mirroring buildAgentCtx (see issue-tools.integration.test.ts),
// with the MCP seat's parseable workspace URL and an optional Org-blocks getter.
function ctxFor(orgBlocks?: readonly GuidanceBlock[]): ToolCtx {
  return {
    userId: USER,
    resolveMemexFromEntity: async () => memexId,
    resolveMemex: async () => memexId,
    resolveRef: async (ref: string) => {
      const parsed = parseRef(ref);
      if (!parsed.ok) throw new ValidationError(`Invalid ref "${ref}": ${parsed.reason}`);
      const result = await resolveCanonicalRef(parsed.ref);
      if ("redirected" in result) {
        throw new ValidationError(`Ref redirected: "${ref}" → "${result.newRef}".`);
      }
      if ("notFound" in result) {
        throw new NotFoundError(`Ref "${ref}" not found (${result.reason})`);
      }
      const entity = result.entity;
      const doc = "doc" in entity ? entity.doc : entity.row;
      if (doc.memexId !== memexId) {
        throw new NotFoundError(`Ref "${ref}" not found.`);
      }
      return {
        entity,
        memexId: doc.memexId,
        doc,
        slugs,
      };
    },
    workspaceUrl: async () => workspaceUrl,
    verbose: false,
    ...(orgBlocks ? { getOrgBlocksForNudge: async () => orgBlocks } : {}),
  };
}

function spec(name: string) {
  const s = toolSpecs.find((t) => t.name === name);
  if (!s) throw new Error(`tool spec ${name} not found`);
  return s;
}

function specRef(handle: string): string {
  return `${slugs.namespace}/${slugs.memex}/specs/${handle}`;
}

/** The interpolation context the UI button builds (DocDocument.tsx) — the
 *  server must compose with the identical shape for byte-parity. */
function uiContext(doc: { handle: string; title: string }) {
  return {
    namespace: slugs.namespace,
    memex: slugs.memex,
    handle: doc.handle,
    title: doc.title,
    url: `${workspaceUrl}/specs/${doc.handle}`,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// ac-6 (dec-1) — current-phase node selection via HANDOFF_BUTTON_BY_PHASE,
// with the {namespace}/{memex}/{handle}/{title}/{url} slots interpolated.
// ──────────────────────────────────────────────────────────────────────────
describe("get_prompt — current-phase handoff selection (ac-6)", () => {
  it.each([
    ["specify", "plan-handoff"],
    ["build", "opening-build-handoff"],
    ["verify", "verify-spec"],
  ] as const)("a Spec in %s returns the %s prompt, interpolated", async (phase, buttonId) => {
    tagAc(AC(6));
    expect(HANDOFF_BUTTON_BY_PHASE[phase]).toBe(buttonId);
    const doc = await makeSpec(`GetPrompt ${phase} Spec`, phase);
    const out = await spec("get_prompt").handler({ ref: specRef(doc.handle) }, ctxFor());

    const expected = toButtonPrompt({
      dataset: BASE_SCAFFOLD,
      buttonId,
      context: uiContext(doc),
    });
    expect(expected).not.toBeNull();
    expect(out).toBe(expected);
    // The slots actually interpolated — no `{handle}`-style residue.
    expect(out).toContain(doc.handle);
    expect(out).toContain(doc.title);
    expect(out).toContain(`${workspaceUrl}/specs/${doc.handle}`);
    expect(out).not.toMatch(/\{(namespace|memex|handle|title|url)\}/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// ac-7 / scope ac-4 (dec-1) — phases with no handoff node return a clear,
// human-readable explanation; never a thrown error or empty string. No
// phase/buttonId override arguments exist on the schema.
// ──────────────────────────────────────────────────────────────────────────
describe("get_prompt — no-handoff phases explain themselves (ac-7, ac-4)", () => {
  it.each(["draft", "done"] as const)(
    "a Spec in %s gets an explanation naming the phases that carry handoffs",
    async (phase) => {
      tagAc(AC(7));
      tagAc(AC(4));
      const doc = await makeSpec(`GetPrompt ${phase} Spec`, phase);
      const out = await spec("get_prompt").handler({ ref: specRef(doc.handle) }, ctxFor());
      expect(out.length).toBeGreaterThan(0);
      expect(out).toBe(GET_PROMPT_PROSE.noHandoff(phase));
      // Names the valid states so an agent can relay it usefully.
      for (const valid of ["specify", "build", "verify"]) {
        expect(out).toContain(valid);
      }
      expect(out).toContain(phase);
    },
  );

  it("accepts no phase/buttonId override arguments (ref + shared verbose only)", () => {
    tagAc(AC(7));
    const fields = Object.keys(spec("get_prompt").schema);
    expect(fields.sort()).toEqual(["ref", "verbose"]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// ac-8 / scope ac-2, ac-3 (dec-2) — Org scaffold appends are composed in, and
// the output is byte-identical to toButtonPrompt with the same dataset,
// buttonId, context, and orgBlocks (what the UI button copies — no new prose).
// ──────────────────────────────────────────────────────────────────────────
const orgBlock = (buttonId: string, text: string): GuidanceBlock => ({
  kind: "guidance_block",
  source: "org",
  target: { button: buttonId },
  text,
  enabled: true,
  order: 1,
  rationale: "test org append",
});

describe("get_prompt — Org appends + byte-parity with the UI button (ac-8, ac-2, ac-3)", () => {
  it("an enabled Org block targeting the phase's handoff button appears in the output", async () => {
    tagAc(AC(8));
    const doc = await makeSpec("GetPrompt Org Spec", "build");
    const org = [orgBlock("opening-build-handoff", "ORG-APPEND-263: follow the acme deploy rules.")];
    const out = await spec("get_prompt").handler({ ref: specRef(doc.handle) }, ctxFor(org));
    expect(out).toContain("ORG-APPEND-263: follow the acme deploy rules.");
  });

  it("output is byte-identical to toButtonPrompt composed with the same inputs (the UI clipboard text)", async () => {
    tagAc(AC(8));
    tagAc(AC(2));
    tagAc(AC(3));
    const doc = await makeSpec("GetPrompt Parity Spec", "verify");
    const org = [orgBlock("verify-spec", "ORG-APPEND-263: verify against staging first.")];
    const out = await spec("get_prompt").handler({ ref: specRef(doc.handle) }, ctxFor(org));

    // EXACTLY what PromptButton.tsx produces: toButtonPrompt over the same
    // scaffold dataset, node, interpolation context, and orgBlocks.
    const uiClipboard = toButtonPrompt({
      dataset: BASE_SCAFFOLD,
      buttonId: "verify-spec",
      context: uiContext(doc),
      orgBlocks: org,
    });
    expect(uiClipboard).not.toBeNull();
    expect(out).toBe(uiClipboard);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// ac-10 / scope ac-5, ac-1 (dec-3) — manifest entry + live registration. The
// std-16 parity regressions (tools-coverage, tool-manifest-args) enforce the
// general lockstep; here get_prompt is pinned on all surfaces directly.
// ──────────────────────────────────────────────────────────────────────────
describe("get_prompt — manifest + catalogue registration (ac-10, ac-5, ac-1)", () => {
  it("is in the @memex/shared manifest as a read-only read-group tool", () => {
    tagAc(AC(10));
    tagAc(AC(5));
    const entry = toolManifest.find((e) => e.name === "get_prompt");
    expect(entry).toBeDefined();
    expect(entry?.group).toBe("read");
    expect(entry?.readOnlyHint).toBe(true);
    expect(entry?.trafficClass).toBeNull();
  });

  it("a matching ToolSpec is registered (read-only annotations) and callable end-to-end", async () => {
    tagAc(AC(10));
    tagAc(AC(5));
    tagAc(AC(1));
    const s = spec("get_prompt");
    expect(s.annotations.readOnlyHint).toBe(true);
    expect(s.annotations.destructiveHint).toBe(false);
    // Callable without the web UI: resolves the Spec and returns the
    // current-phase handoff, ready to act on.
    const doc = await makeSpec("GetPrompt MCP Spec", "build");
    const out = await s.handler({ ref: specRef(doc.handle) }, ctxFor());
    expect(out).toBe(
      toButtonPrompt({
        dataset: BASE_SCAFFOLD,
        buttonId: "opening-build-handoff",
        context: uiContext(doc),
      }),
    );
  });

  it("rejects non-Spec docs with a clear validation error", async () => {
    tagAc(AC(10));
    const doc = await createDocDraft(memexId, "GetPrompt Standard", "a standard", "standard");
    createdDocIds.push(doc.id);
    await expect(
      spec("get_prompt").handler(
        { ref: `${slugs.namespace}/${slugs.memex}/standards/${doc.handle}` },
        ctxFor(),
      ),
    ).rejects.toThrow(/Spec/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// ac-9 (dec-2) — the EXISTING fullHandoff composition in the get_doc verbose
// footer passes orgBlocks into toButtonPrompt, closing the live parity gap:
// one server-side composition behaviour for the handoff prompt, everywhere.
// ──────────────────────────────────────────────────────────────────────────
describe("get_doc verbose footer — fullHandoff composes with orgBlocks (ac-9)", () => {
  it("the once-per-session full embed contains the Org append, byte-equal to the button composition", async () => {
    tagAc(AC(9));
    const doc = await makeSpec("GetPrompt Footer Org Spec", "build");
    const org = [
      orgBlock("opening-build-handoff", "ORG-APPEND-263-FOOTER: follow the acme build rules."),
    ];
    // Unique session so claimFullHandoffDelivery grants the once-per-session
    // full embed to THIS call (the existing spec-203 channel, unchanged).
    const ctx: ToolCtx = {
      ...ctxFor(org),
      verbose: true,
      sessionId: `spec263-ac9-${Date.now()}`,
      toolName: "get_doc",
    };
    const env = await composeGuidanceEnvelope(memexId, doc.id, ctx);
    const footer = env.footer ?? "";
    // The full embed fired (it carries the interpolated handoff for this spec)…
    expect(footer).toContain(`${workspaceUrl}/specs/${doc.handle}`);
    // …and composes WITH the Org append, exactly as the UI button does (dec-2).
    expect(footer).toContain("ORG-APPEND-263-FOOTER: follow the acme build rules.");
    const expected = toButtonPrompt({
      dataset: BASE_SCAFFOLD,
      buttonId: "opening-build-handoff",
      context: uiContext(doc),
      orgBlocks: org,
    });
    expect(expected).not.toBeNull();
    expect(footer).toContain(expected as string);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// ac-11 (dec-4) — the one-line get_prompt pointer rides the handoff essence at
// the three footer moments: the get_doc essence line (terse + verbose), the
// assess_spec phase-mode footer, and the update_doc forward-transition footer.
// Additive: the once-per-session full embed in verbose get_doc is unchanged
// (proven above in the ac-9 test — the embed still fires and composes fully).
// ──────────────────────────────────────────────────────────────────────────
describe("get_prompt pointer rides the handoff essence at the footer moments (ac-11)", () => {
  const POINTER = GET_PROMPT_PROSE.pointer;

  it.each(["get_doc", "assess_spec"] as const)(
    "the terse orient footer for %s carries the essence + pointer",
    async (toolName) => {
      tagAc(AC(11));
      const doc = await makeSpec(`Pointer ${toolName} Spec`, "build");
      const ctx: ToolCtx = { ...ctxFor(), toolName };
      const env = await composeGuidanceEnvelope(memexId, doc.id, ctx);
      const footer = env.footer ?? "";
      expect(footer).toContain(toHandoffEssence(BASE_SCAFFOLD, "build") as string);
      expect(footer).toContain(POINTER);
    },
  );

  it("the update_doc forward-transition footer carries the target phase's essence + pointer", async () => {
    tagAc(AC(11));
    const doc = await makeSpec("Pointer Transition Spec", "build");
    const ctx: ToolCtx = {
      ...ctxFor(),
      toolName: "update_doc",
      footerSlot: {
        signal: { kind: "doc_transition", beforeStatus: "specify", target: "build", docType: "spec" },
      },
    };
    const env = await composeGuidanceEnvelope(memexId, doc.id, ctx);
    const footer = env.footer ?? "";
    expect(footer).toContain(toHandoffEssence(BASE_SCAFFOLD, "build") as string);
    expect(footer).toContain(POINTER);
  });

  it("the verbose get_doc essence line carries the pointer once the full embed has been claimed", async () => {
    tagAc(AC(11));
    const doc = await makeSpec("Pointer Verbose Spec", "build");
    const sessionId = `spec263-ac11-${Date.now()}`;
    const ctx: ToolCtx = { ...ctxFor(), verbose: true, sessionId, toolName: "get_doc" };
    // First verbose call claims the once-per-session FULL embed (spec-203
    // channel, unchanged) — subsequent calls fall back to the essence line.
    await composeGuidanceEnvelope(memexId, doc.id, ctx);
    const env = await composeGuidanceEnvelope(memexId, doc.id, ctx);
    const footer = env.footer ?? "";
    expect(footer).toContain(toHandoffEssence(BASE_SCAFFOLD, "build") as string);
    expect(footer).toContain(POINTER);
  });

  it("get_prompt's own response footer does NOT point at itself", async () => {
    tagAc(AC(11));
    const doc = await makeSpec("Pointer Self Spec", "build");
    const ctx: ToolCtx = { ...ctxFor(), toolName: "get_prompt" };
    const env = await composeGuidanceEnvelope(memexId, doc.id, ctx);
    expect(env.footer ?? "").not.toContain(POINTER);
  });

  it("no pointer for phases with no handoff (draft)", async () => {
    tagAc(AC(11));
    const doc = await makeSpec("Pointer Draft Spec", "draft");
    const ctx: ToolCtx = { ...ctxFor(), toolName: "get_doc" };
    const env = await composeGuidanceEnvelope(memexId, doc.id, ctx);
    expect(env.footer ?? "").not.toContain(POINTER);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// ac-12 (dec-4) — documentation lives where agents look: the phases topic
// documents get_prompt, the manifest summary states WHEN to call it, and all
// new nudge prose lives in scaffold-data (no prompt literals in TypeScript —
// the scaffold drift-guard enforces the general rule; pinned here for the
// spec-263 additions specifically).
// ──────────────────────────────────────────────────────────────────────────
describe("get_prompt — documentation + prose home (ac-12)", () => {
  it("get_information(topic='phases') documents get_prompt", async () => {
    tagAc(AC(12));
    const { readFile } = await import("node:fs/promises");
    const raw = await readFile(
      new URL("../guidance/phases.json", import.meta.url),
      "utf8",
    );
    const topic = JSON.parse(raw) as { body: string };
    expect(topic.body).toContain("get_prompt");
    // Documents the semantics, not just the name: current phase + the same
    // text as the web UI's copy-prompt button.
    expect(topic.body.toLowerCase()).toContain("copy-prompt button");
  });

  it("the manifest description states when to call it", () => {
    tagAc(AC(12));
    const entry = toolManifest.find((e) => e.name === "get_prompt");
    expect(entry?.summary).toMatch(/after orienting on a Spec/i);
    expect(entry?.summary).toMatch(/phase transition/i);
  });

  it("the nudge prose lives in scaffold-data (@memex/shared), not in server TypeScript", () => {
    tagAc(AC(12));
    // The pointer and no-handoff prose the server sites consume are the
    // GET_PROMPT_PROSE exports — single home per std-15/std-23.
    expect(GET_PROMPT_PROSE.pointer).toContain("get_prompt");
    expect(GET_PROMPT_PROSE.noHandoff("draft")).toContain("specify");
  });
});
