// spec-535 t-4 — the flag's MCP tool, and the gate it deliberately sits outside.
//
// ac-20 is the one that matters, and it is written as a BEHAVIOURAL test with a
// control rather than a set-membership check. Asserting `!GATED_SPEC_TOOLS.has(x)`
// would pass just as happily if the gate stopped working altogether; running the
// real gate against a real colliding checkout, and proving a gated tool DOES throw
// in the same conditions, is what actually pins the difference.
//
// Why the tool is ungated (dec-6): the gate throws a takeover error when another
// user has held the Spec for less than the collision window. Applied to this flag
// that would mean an agent noticing a Spec is dangerous *while a colleague works
// it* must seize that colleague's checkout in order to post the warning about
// them — the mechanism built to avoid stepping on someone would require stepping
// on them to use. `claim_spec` / `unclaim_spec` are already excluded for the
// structurally identical reason: they are meta-operations about who is working,
// not edits to the work.

import { describe, it, expect, beforeAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "../db/connection.js";
import { documents } from "../db/schema.js";
import { makeTestMemex } from "../services/test-helpers.js";
import { upsertUserByEmail } from "../services/users.js";
import { enforceCheckoutGate } from "../services/checkout-gate.js";
import { GATED_SPEC_TOOLS } from "../services/checkout-gate.js";
import { stampCheckout } from "../services/checkout.js";
import { toolSpecs } from "./tool-specs.js";
import type { ToolCtx } from "./handlers/tool-contract.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-535/acs/ac-${n}`;
const TOOL = "set_sensitive";

function ctxFor(userId: string, sessionId: string, docId: string): ToolCtx {
  return {
    userId,
    sessionId,
    resolveRef: async () => ({
      memexId: "m",
      doc: { id: docId, docType: "spec" },
      entity: { kind: "document" },
    }),
  } as unknown as ToolCtx;
}

describe("spec-535 t-4: the set_sensitive tool", () => {
  let memexId: string;

  beforeAll(async () => {
    memexId = await makeTestMemex("settool");
  });

  async function makeSpec(handle: string): Promise<string> {
    const [doc] = await db
      .insert(documents)
      .values({ memexId, handle, title: handle, docType: "spec" })
      .returning();
    return doc.id;
  }

  it("ac-20: flagging a Spec a colleague holds right now succeeds, where a gated tool refuses", async () => {
    tagAc(AC(20));
    const holder = await upsertUserByEmail("spec535-holder@example.com");
    const noticer = await upsertUserByEmail("spec535-noticer@example.com");
    const docId = await makeSpec("spec-gate-collision");

    // The colleague is actively on it — a checkout stamped just now, well inside
    // the collision window. This is the exact state the feature exists for.
    await stampCheckout({ docId, userId: holder.id, thread: "their-session" });

    // CONTROL: a gated tool refuses in these conditions. If this stops throwing,
    // the assertion below proves nothing, so it is checked in the same test.
    await expect(
      enforceCheckoutGate("update_section", { ref: "spec-1" }, ctxFor(noticer.id, "s", docId)),
    ).rejects.toThrow();

    // THE CLAIM: the flag tool passes through the same gate untouched.
    await expect(
      enforceCheckoutGate(TOOL, { ref: "spec-1" }, ctxFor(noticer.id, "s", docId)),
    ).resolves.toBeUndefined();
  });

  it("ac-20: the tool is absent from the gate's allow-list", () => {
    tagAc(AC(20));
    expect(GATED_SPEC_TOOLS.has(TOOL)).toBe(false);
    // The company it keeps: the checkout verbs, excluded for the same reason.
    expect(GATED_SPEC_TOOLS.has("claim_spec")).toBe(false);
    expect(GATED_SPEC_TOOLS.has("unclaim_spec")).toBe(false);
    // And the contrast that gives the exclusion meaning.
    expect(GATED_SPEC_TOOLS.has("update_section")).toBe(true);
  });

  it("ac-21: the exclusion is documented at its site, so it cannot read as an oversight", () => {
    tagAc(AC(21));
    // Without a stated reason a future reader sees a mutating tool missing from
    // the list, assumes an omission, adds it, and silently reinstates the defect.
    // The checkout verbs already carry their own why; this asserts ours does too.
    const src = readFileSync(
      join(__dirname, "..", "services", "checkout-gate.ts"),
      "utf-8",
    );
    expect(src).toMatch(new RegExp(TOOL));
    // The mention must sit in prose explaining the absence, not in the Set.
    const setStart = src.indexOf("GATED_SPEC_TOOLS = new Set");
    const setEnd = src.indexOf("]);", setStart);
    const insideTheSet = src.slice(setStart, setEnd);
    expect(insideTheSet, `${TOOL} must NOT be inside the allow-list`).not.toMatch(
      new RegExp(TOOL),
    );
  });

  it("ac-20: the tool is registered in the catalogue as a mutating tool", () => {
    tagAc(AC(20));
    const spec = toolSpecs.find((t) => t.name === TOOL);
    expect(spec, `${TOOL} is missing from toolSpecs`).toBeDefined();
    expect(spec?.annotations?.readOnlyHint).toBe(false);
  });

  it("ac-7: the tool signature accepts no reason or free-text argument", () => {
    tagAc(AC(7));
    const spec = toolSpecs.find((t) => t.name === TOOL);
    const keys = Object.keys(spec?.schema ?? {});
    expect(keys).not.toContain("reason");
    expect(keys).not.toContain("note");
    expect(keys).not.toContain("description");
  });
});
