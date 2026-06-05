// Telemetry smoke (std-17 follow-up for MR !20).
//
// Verifies that every MCP tool call writes a correctly-attributed row to
// mcp_tool_calls on the live deployed host. This is the ONLY way to catch a
// future regression where someone disables the wrap, breaks the upsertSession
// path, inverts the isDevMode gate, or otherwise silently breaks telemetry.
// Pure HTTP smoke (the existing tier) won't catch any of that because the
// tool calls succeed from the agent's perspective — only the side-effect into
// the audit table goes missing.
//
// Skips cleanly when SMOKE_DATABASE_URL is unset (cloud-sql-proxy isn't
// always running). In CI / from the deploy tail, the make targets
// `smoke-int-with-db` / `smoke-prod-with-db` spin up the proxy first.
//
// Probes:
//   1. A successful tool call (get_information) writes a row with no error,
//      duration captured, args captured as JSONB.
//   2. A deliberately failing tool call (get_doc with malformed ref) writes
//      a row whose error column contains the FULL envelope (name + message
//      + stack), not just the redacted "Validation error: ..." the agent
//      saw. This locks in the richer-error-capture fix in mcp/tools.ts.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  SMOKE_BASE_URL,
  SMOKE_DATABASE_URL,
  SMOKE_MCP_TOKEN,
  callMcpTool,
} from "./smoke-env.js";

const ENABLED = !!SMOKE_MCP_TOKEN && !!SMOKE_DATABASE_URL;

describe.skipIf(!ENABLED)(
  `telemetry smoke @ ${SMOKE_BASE_URL}`,
  () => {
    let sql: ReturnType<typeof postgres>;
    // Captured at start so the per-test queries filter to "rows from this
    // smoke run", not "all rows by this user since the beginning of time".
    // Subtract a small slack so clock drift between the test machine and
    // the DB doesn't cause us to miss rows we just wrote.
    const startedAt = new Date(Date.now() - 2_000);

    beforeAll(() => {
      sql = postgres(SMOKE_DATABASE_URL, { max: 2 });
    });

    afterAll(async () => {
      await sql?.end?.({ timeout: 5 });
    });

    it("a successful MCP tool call lands a row with no error + populated args + non-zero duration", async () => {
      // Fire the probe call.
      const { status, body } = await callMcpTool("get_information", {});
      expect(status).toBe(200);
      expect(body.result?.isError).toBeFalsy();

      // Allow a moment for the fire-and-forget logToolCall insert
      // to land. The wrap awaits internally before responding, but the SDK
      // may flush response bytes before the finally{} fully resolves.
      await new Promise((r) => setTimeout(r, 250));

      // Query for the row. Filter by tool_name + recent time to avoid
      // colliding with other concurrent smoke runs.
      const rows = await sql<
        Array<{ error: string | null; args_json: unknown; duration_ms: number }>
      >`
        SELECT error, args_json, duration_ms
        FROM mcp_tool_calls
        WHERE tool_name = 'get_information'
          AND created_at > ${startedAt}
        ORDER BY created_at DESC
        LIMIT 1
      `;
      expect(rows.length).toBe(1);
      expect(rows[0].error).toBeNull();
      expect(rows[0].args_json).toEqual({});
      expect(rows[0].duration_ms).toBeGreaterThan(0);
    });

    it("a failing MCP tool call lands a row with the FULL error envelope (name + message + stack), not the agent-facing redacted message", async () => {
      // Fire a call that throws a ValidationError deep in resolveRefForUser.
      const badRef = "mindset-int/memex-app/briefs/b-99999-does-not-exist";
      const { body } = await callMcpTool("get_doc", { ref: badRef });
      // Agent sees the SHORT redacted form: `Validation error: Invalid ref ...`
      // The telemetry row should contain MORE than this.
      const agentFacing =
        body.result?.content?.[0]?.text ??
        body.error?.message ??
        "<no agent-facing error>";
      expect(agentFacing).toMatch(/Validation error: Invalid ref/);

      await new Promise((r) => setTimeout(r, 250));

      const rows = await sql<Array<{ error: string | null }>>`
        SELECT error
        FROM mcp_tool_calls
        WHERE tool_name = 'get_doc'
          AND created_at > ${startedAt}
          AND args_json ->> 'ref' = ${badRef}
        ORDER BY created_at DESC
        LIMIT 1
      `;
      expect(rows.length).toBe(1);
      const error = rows[0].error;
      expect(error).not.toBeNull();
      // Telemetry envelope must carry the underlying Error class name and
      // the call-site stack, not just the redacted message. If a future
      // change reverts to logging the redacted string, these assertions
      // fail loudly.
      expect(error).toMatch(/ValidationError/);
      expect(error!.length).toBeGreaterThan(agentFacing.length);
      expect(error).toMatch(/\s+at\s+/); // a stack frame line
    });
  },
);
