// spec-499 t-1 (dec-1) — undeclared tool arguments SURVIVE MCP argument validation.
//
// Zod objects strip unknown keys by default, and the SDK hands the handler the parsed
// (stripped) result. That strip is what made the forced-facet-ballot failure
// undiagnosable: a ballot sent as `facet_ballot` and a ballot never sent at all reached
// the handler as the identical state, so the server could only ever say "none was
// supplied". Registering the shape as a LOOSE object preserves the key so the error can
// name what actually arrived (services/facet-ballot.ts).
//
// These assertions go through the REAL registration path — createMcpServer's
// `_registeredTools`, the same introspection the std-16 parity gate uses — and through
// the SDK's own validate/publish helpers, so they'd catch the seam regressing back to a
// bare shape. No DB.

import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { readFileSync } from "node:fs";
import { normalizeObjectSchema, safeParseAsync } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { createMcpServer } from "./tools.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-499/acs/ac-${n}`;

const TEST_USER_ID = "00000000-0000-0000-0000-00000000beef";

/** The schema the SDK actually stored for a tool, as its own helpers expect it. */
type RegisteredSchema = NonNullable<Parameters<typeof normalizeObjectSchema>[0]>;

function registeredTool(name: string): RegisteredSchema {
  const server = createMcpServer(TEST_USER_ID);
  const tools = (
    server as unknown as { _registeredTools: Record<string, { inputSchema?: RegisteredSchema }> }
  )._registeredTools;
  const tool = tools[name];
  if (!tool?.inputSchema) throw new Error(`no registered tool '${name}' with an inputSchema`);
  return tool.inputSchema;
}

/** The registered schema as an object schema — the form both SDK paths normalise to. */
function normalised(toolName: string) {
  const obj = normalizeObjectSchema(registeredTool(toolName));
  // A bare raw shape would normalise to a STRICT object and silently strip again, so
  // failing here is itself the regression signal.
  if (!obj) throw new Error(`tool '${toolName}' did not normalise to an object schema`);
  return obj;
}

/** Parse args exactly as the SDK does before dispatching to a handler (mcp.js). */
async function parseAsSdk(toolName: string, args: Record<string, unknown>) {
  return (await safeParseAsync(normalised(toolName), args)) as
    | { success: true; data: Record<string, unknown> }
    | { success: false; error: unknown };
}

/** The JSON Schema the SDK publishes for a tool in its tools/list response. */
function publishedSchema(toolName: string): {
  properties?: Record<string, unknown>;
  required?: string[];
} {
  return toJsonSchemaCompat(normalised(toolName), {} as never) as never;
}

const COMPLETE_BALLOT = { none: false, verdict: { "xc-security": true, "xc-perf": false } };

describe("spec-499 dec-1 — undeclared arguments survive MCP validation", () => {
  it("keeps an argument the schema doesn't declare instead of stripping it (ac-5)", async () => {
    tagAc(AC(5));
    const result = await parseAsSdk("create_decision", {
      ref: "ns/main/specs/spec-1",
      title: "T",
      // The exact shape that used to vanish: a complete ballot under a near-miss name.
      facet_ballot: COMPLETE_BALLOT,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    // Visible to the handler — this is what requireLead() reads to name the near miss.
    expect(Object.keys(result.data)).toContain("facet_ballot");
    expect(result.data.facet_ballot).toEqual(COMPLETE_BALLOT);
    // ...and the declared arguments still arrive normally.
    expect(result.data.ref).toBe("ns/main/specs/spec-1");
    expect(result.data.title).toBe("T");
  });

  it("preserves undeclared arguments on create_task too, not just create_decision (ac-5)", async () => {
    tagAc(AC(5));
    const result = await parseAsSdk("create_task", {
      ref: "ns/main/specs/spec-1",
      title: "T",
      description: "d",
      facet_ballot: COMPLETE_BALLOT,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(Object.keys(result.data)).toContain("facet_ballot");
  });

  it("still accepts a correctly-named ballot unchanged (ac-4)", async () => {
    tagAc(AC(4));
    const result = await parseAsSdk("create_decision", {
      ref: "ns/main/specs/spec-1",
      title: "T",
      facetBallot: COMPLETE_BALLOT,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.facetBallot).toEqual(COMPLETE_BALLOT);
  });

  it("still REJECTS a malformed ballot — loose applies to unknown keys, not to declared types (ac-4)", async () => {
    tagAc(AC(4));
    // Guards the boundary of the change: a stringified ballot must keep failing loudly
    // at the SDK, which is why it never reaches the "none was supplied" branch at all.
    const stringified = await parseAsSdk("create_decision", {
      ref: "ns/main/specs/spec-1",
      title: "T",
      facetBallot: JSON.stringify(COMPLETE_BALLOT),
    });
    expect(stringified.success).toBe(false);

    const badVerdictType = await parseAsSdk("create_decision", {
      ref: "ns/main/specs/spec-1",
      title: "T",
      facetBallot: { none: false, verdict: { "xc-security": "true" } },
    });
    expect(badVerdictType.success).toBe(false);
  });

  it("still REJECTS a call missing a genuinely required argument (ac-4)", async () => {
    tagAc(AC(4));
    const result = await parseAsSdk("create_decision", { title: "no ref" });
    expect(result.success).toBe(false);
  });
});

describe("spec-499 dec-1 — the published tool contract is unchanged", () => {
  it("create_decision still declares facetBallot and still requires exactly [ref, title] (ac-6)", () => {
    tagAc(AC(6));
    const schema = publishedSchema("create_decision");
    expect(schema.properties).toHaveProperty("facetBallot");
    // Requiredness is what models actually condition on — the loose change must not
    // touch it in either direction.
    expect(schema.required).toEqual(["ref", "title"]);
  });

  it("create_task still declares facetBallot and keeps its required set (ac-6)", () => {
    tagAc(AC(6));
    const schema = publishedSchema("create_task");
    expect(schema.properties).toHaveProperty("facetBallot");
    expect(schema.required).toEqual(["ref", "title", "description"]);
  });
});

describe("spec-499 dec-4 — licence boundary", () => {
  it("changes stay in the fair-code core: no .ee marker on any touched file (ac-11)", () => {
    tagAc(AC(11));
    const touched = [
      "src/mcp/tools.ts",
      "src/services/facet-ballot.ts",
      "src/agent/handlers/decisions.ts",
      "src/agent/handlers/tasks.ts",
      "src/mcp/loose-tool-args.spec-499.test.ts",
      "src/agent/facet-ballot-diagnosis.spec-499.integration.test.ts",
    ];
    for (const path of touched) {
      // Each file exists where the Spec says it does...
      expect(() => readFileSync(new URL(`../../${path}`, import.meta.url))).not.toThrow();
      // ...and carries neither licence marker (`.ee.` filename or `.ee/` dirname).
      expect(path).not.toMatch(/\.ee\./);
      expect(path).not.toMatch(/(^|\/)\.ee\//);
    }
  });
});
