// spec-181 / dec-1 — the `plan` → `specify` phase-VALUE migration error.
//
// The second Spec pipeline phase was renamed `plan` → `specify` (the pipeline is
// now draft → specify → build → verify → done). dec-1 resolved: inbound
// `status:"plan"` / `target:"plan"` at the MCP boundary must return a STRUCTURED
// error naming the rename + the corrective action (re-read tools/list) — with NO
// coercion / aliasing. The zod enums on update_doc.status / publish_spec.status /
// assess_spec.target were renamed in lock-step, so without this intercept "plan"
// would surface as a generic Zod enum error with no migration path.
//
// Two layers, mirroring migration-errors.integration.test.ts:
//   1. Pure: `phaseValueMigrationErrorMessage(args)` returns a structured string
//      naming the rename + the action, and is null for non-offending args.
//   2. End-to-end through the HTTP MCP endpoint: `tools/call` with
//      update_doc({status:"plan"}) and publish_spec({status:"plan"}) returns the
//      structured error BEFORE any DB work (the intercept fires in app.ts).
//
// The pure layer needs no DB; the HTTP layer mints a throwaway token.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../app.js";
import { db } from "../db/connection.js";
import { users, mcpTokens } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { randomBytes, createHash } from "node:crypto";
import { tagAc } from "@memex-ai-ac/vitest";
import { phaseValueMigrationErrorMessage } from "./migration-map.js";

const AC_9 = "mindset-prod/memex-building-itself/specs/spec-181/acs/ac-9";

// ── Pure: phaseValueMigrationErrorMessage() ───────────────────────────
describe("spec-181 ac-9: phaseValueMigrationErrorMessage() names the rename + the action", () => {
  it("returns null for args with no phase-sense `plan` value", () => {
    tagAc(AC_9);
    tagAc("mindset-prod/memex-building-itself/specs/spec-181/acs/ac-3");
    expect(phaseValueMigrationErrorMessage({})).toBeNull();
    expect(phaseValueMigrationErrorMessage({ status: "specify" })).toBeNull();
    expect(phaseValueMigrationErrorMessage({ status: "build" })).toBeNull();
    expect(phaseValueMigrationErrorMessage({ target: "verify" })).toBeNull();
    // The `plan` COMMENT TYPE is a different vocabulary — it arrives on `type`,
    // not a phase-sense field, so it must NOT trigger the migration error.
    expect(phaseValueMigrationErrorMessage({ type: "plan" })).toBeNull();
    expect(phaseValueMigrationErrorMessage({ types: ["plan"] })).toBeNull();
  });

  it("returns a structured error naming 'specify' and the re-read action for status='plan'", () => {
    tagAc(AC_9);
    tagAc("mindset-prod/memex-building-itself/specs/spec-181/acs/ac-3");
    const msg = phaseValueMigrationErrorMessage({ status: "plan" });
    expect(msg).toBeTruthy();
    // Names the retired value and the replacement.
    expect(msg).toContain("plan");
    expect(msg).toContain("specify");
    // Names the corrective action.
    expect(msg).toMatch(/tools\/list/);
    // No-alias contract is spelled out.
    expect(msg).toMatch(/no alias/i);
  });

  it("fires for target='plan' (assess_spec) and statusIn containing 'plan' (list_docs)", () => {
    tagAc(AC_9);
    tagAc("mindset-prod/memex-building-itself/specs/spec-181/acs/ac-3");
    expect(phaseValueMigrationErrorMessage({ target: "plan" })).toBeTruthy();
    expect(
      phaseValueMigrationErrorMessage({ statusIn: ["plan", "build"] }),
    ).toBeTruthy();
    // statusIn with no `plan` is clean.
    expect(
      phaseValueMigrationErrorMessage({ statusIn: ["specify", "build"] }),
    ).toBeNull();
  });
});

// ── HTTP-level path through app.ts ────────────────────────────────────
const created = { tokens: [] as string[], users: [] as string[] };

async function mintTestToken(): Promise<{ raw: string; userId: string }> {
  const sub = `p2s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toLowerCase();
  const [u] = await db.insert(users).values({ email: `${sub}@memex.ai` } as any).returning();
  created.users.push(u.id);
  const raw = `mxt_${randomBytes(24).toString("hex")}`;
  const tokenHash = createHash("sha256").update(raw).digest("hex");
  const [tok] = await db
    .insert(mcpTokens)
    .values({
      userId: u.id,
      label: "plan-to-specify-migration-test",
      tokenHash,
      prefix: raw.slice(0, 12),
    } as any)
    .returning();
  created.tokens.push(tok.id);
  return { raw, userId: u.id };
}

afterAll(async () => {
  for (const id of created.tokens) await db.delete(mcpTokens).where(eq(mcpTokens.id, id)).catch(() => {});
  for (const id of created.users) await db.delete(users).where(eq(users.id, id)).catch(() => {});
});

async function callToolHttp(
  token: string,
  id: number,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const req = new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const res = await app.fetch(req);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    result: { isError: boolean; content: Array<{ type: string; text: string }> };
  };
  return { isError: body.result.isError, text: body.result.content[0].text };
}

describe("spec-181 ac-9: MCP HTTP endpoint returns the structured plan→specify error", () => {
  let token: { raw: string; userId: string };

  beforeAll(async () => {
    token = await mintTestToken();
  });

  it("update_doc({status:'plan'}) returns the structured rename error (no generic Zod enum error)", async () => {
    tagAc(AC_9);
    tagAc("mindset-prod/memex-building-itself/specs/spec-181/acs/ac-3");
    const { isError, text } = await callToolHttp(token.raw, 181001, "update_doc", {
      ref: "anyns/anymemex/specs/spec-1",
      status: "plan",
    });
    expect(isError).toBe(true);
    expect(text).toContain("specify");
    expect(text).toMatch(/tools\/list/);
    // It must NOT be the generic Zod enum error.
    expect(text).not.toMatch(/invalid enum value/i);
  });

  it("publish_spec({status:'plan'}) returns the structured rename error", async () => {
    tagAc(AC_9);
    tagAc("mindset-prod/memex-building-itself/specs/spec-181/acs/ac-3");
    const { isError, text } = await callToolHttp(token.raw, 181002, "publish_spec", {
      ref: "anyns/anymemex/specs/spec-1",
      status: "plan",
    });
    expect(isError).toBe(true);
    expect(text).toContain("specify");
    expect(text).toMatch(/tools\/list/);
  });

  it("assess_spec({target:'plan'}) returns the structured rename error", async () => {
    tagAc(AC_9);
    tagAc("mindset-prod/memex-building-itself/specs/spec-181/acs/ac-3");
    const { isError, text } = await callToolHttp(token.raw, 181003, "assess_spec", {
      ref: "anyns/anymemex/specs/spec-1",
      mode: "phase",
      target: "plan",
    });
    expect(isError).toBe(true);
    expect(text).toContain("specify");
  });
});
