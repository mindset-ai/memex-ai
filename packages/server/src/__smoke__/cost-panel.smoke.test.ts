// Cost-panel smoke (spec-552 t-6) [per std-17].
//
// THE FAILURE THIS EXISTS FOR IS SILENT. `result_text_length` is written with
// no gate and read by nothing else, so a regression — an inverted condition, a
// dropped insert field, a migration that did not run on this env — produces a
// column full of NULLs, no error anywhere, and a cost card that is simply
// blank. Every local test can stay green through all of it. Only a live row
// settles it.
//
// Three probes, in the order they can lie to you:
//
//   1. The column POPULATES on the deployed host. Drive a real MCP call, then
//      read the row it wrote. Not "the endpoint answered 200" — the row.
//   2. result_text_length >= footer_text_length holds on real rows. The card
//      derives the answer half by subtracting; if the inequality ever breaks,
//      that subtraction silently goes negative. Arithmetic, not string
//      matching for a truncation marker.
//   3. The ROLLOUT GATE reached the running revision. Requesting the cost
//      aggregate and getting `available: true` is a BEHAVIOURAL read-back of
//      COST_PANEL_MEMEXES: if the value had been stranded anywhere along its
//      four deploy links (GitHub Environment variable → deploy.yml →
//      deploy-config.sh's set-vs-unset export → deploy.sh's Cloud Run wiring),
//      the gate would be closed and this would read `false`. That is a
//      stronger check than reading the config back, and it needs no gcloud.
//
// ⚠ WHICH DIRECTION IS VERIFIABLE WHERE. int runs with COST_PANEL_MEMEXES="*"
// (dec-8), so on int only the OPEN direction exists — every Memex is admitted
// and the closed states are unreachable. The CLOSED direction is verifiable on
// PROD, where the value names the dogfood Memex alone: any other Memex is then
// closed. Do not read a green int smoke as proof the gate can refuse.
//
// Skips cleanly without SMOKE_MCP_TOKEN / SMOKE_DATABASE_URL (cloud-sql-proxy
// is not always up); `make smoke-int-with-db` / `smoke-prod-with-db` start it.
// ⚠ A skipped tier looks identical to a passing one. If this file matters to
// you, confirm from the printed row counts below that it actually ran.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  SMOKE_BASE_URL,
  SMOKE_CANONICAL_REF,
  SMOKE_DATABASE_URL,
  SMOKE_MCP_TOKEN,
  SMOKE_NAMESPACE,
  SMOKE_SESSION_TOKEN,
  callMcpTool,
} from "./smoke-env.js";

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-552/acs/ac-${n}`;

const DB_ENABLED = !!SMOKE_MCP_TOKEN && !!SMOKE_DATABASE_URL;

describe.skipIf(!DB_ENABLED)(
  `cost-panel telemetry smoke @ ${SMOKE_BASE_URL}`,
  () => {
    let sql: ReturnType<typeof postgres>;
    // Filter to rows from THIS run, with slack for clock drift between this
    // machine and the database.
    const startedAt = new Date(Date.now() - 2_000);

    beforeAll(async () => {
      sql = postgres(SMOKE_DATABASE_URL, { max: 2 });
      // Real traffic on the live host, so there is a row to read.
      await callMcpTool("get_information", { topic: "phases" });
    });

    afterAll(async () => {
      await sql?.end?.({ timeout: 5 });
    });

    it("populates result_text_length on the deployed host", async () => {
      tagAc(AC(6));
      const rows = await sql<{ n: number; with_len: number; max_len: number }[]>`
        SELECT count(*)::int                     AS n,
               count(result_text_length)::int    AS with_len,
               coalesce(max(result_text_length), 0)::int AS max_len
        FROM mcp_tool_calls
        WHERE created_at >= ${startedAt}
      `;
      const [row] = rows;
      // Printed so a reader can tell a PASS from a SKIP — the whole point of
      // this file is that silence is indistinguishable from success.
      console.log(
        `[cost-panel smoke] rows since start: ${row.n}, with a length: ${row.with_len}, max length: ${row.max_len}`
      );

      expect(row.n).toBeGreaterThan(0);
      // The load-bearing assertion: EVERY row written since this run started
      // carries a length. A partial count means something is gating the write.
      expect(row.with_len).toBe(row.n);
      expect(row.max_len).toBeGreaterThan(0);
    });

    it("keeps result_text_length >= footer_text_length on real rows", async () => {
      tagAc(AC(7));
      const rows = await sql<{ violations: number; checked: number }[]>`
        SELECT count(*) FILTER (
                 WHERE result_text_length < footer_text_length
               )::int AS violations,
               count(*)::int AS checked
        FROM mcp_tool_calls
        WHERE created_at >= ${startedAt}
          AND result_text_length IS NOT NULL
          AND footer_text_length IS NOT NULL
      `;
      const [row] = rows;
      console.log(
        `[cost-panel smoke] rows with both lengths: ${row.checked}, inequality violations: ${row.violations}`
      );
      // The card derives the ANSWER half as result − footer. If this ever
      // inverts, that subtraction goes negative and the card reports nonsense
      // with nothing failing.
      expect(row.violations).toBe(0);
    });
  }
);

// The gate's behavioural read-back needs a session (the aggregate requires
// MEMBERSHIP, dec-9), not an MCP token — so it gates on a different variable
// and lives in its own tier.
describe.skipIf(!SMOKE_SESSION_TOKEN)(
  `cost-panel rollout gate @ ${SMOKE_BASE_URL}`,
  () => {
    it("serves the aggregate, proving COST_PANEL_MEMEXES reached the revision", async () => {
      tagAc(AC(20));
      const res = await fetch(
        `${SMOKE_BASE_URL}/api/${SMOKE_NAMESPACE}/analytics/cost-panel`,
        { headers: { Cookie: `session=${SMOKE_SESSION_TOKEN}` } }
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { available: boolean };
      console.log(
        `[cost-panel smoke] gate for ${SMOKE_NAMESPACE} (ref ${SMOKE_CANONICAL_REF}): available=${body.available}`
      );

      // On int this MUST be true: the env runs "*" (dec-8), so a false here
      // means the value never reached the running revision — the exact silent
      // failure ac-20's four-link guard exists to prevent, caught at the one
      // moment the source scan cannot see.
      //
      // On PROD this is expected FALSE for the throwaway smoke namespace,
      // because the value names only the dogfood Memex. That asymmetry is the
      // point: the closed direction is verifiable there and not here.
      if (process.env.SMOKE_ENV === "prod") {
        expect(body.available).toBe(false);
      } else {
        expect(body.available).toBe(true);
      }
    });
  }
);
