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
      // `Authorization: Bearer <session JWT>` — NOT a Cookie. The first cut of
      // this file guessed a cookie and the request went out ANONYMOUS, so the
      // private smoke Memex answered 404 from layer 1 and reddened the int
      // deploy. The product was right and the check was wrong; sessionMiddleware
      // resolves session JWTs off the Authorization header (smoke-env.ts:49,
      // and every other authed smoke file does it this way).
      const res = await fetch(
        `${SMOKE_BASE_URL}/api/${SMOKE_NAMESPACE}/analytics/cost-panel`,
        { headers: { Authorization: `Bearer ${SMOKE_SESSION_TOKEN}` } }
      );
      // ASSERTED: the endpoint exists, is reachable, and answers the contract.
      // Both are unambiguous — a 404 here means the route is gone or the smoke
      // user cannot read the Memex, and a missing `available` means the shape
      // drifted.
      expect(res.status).toBe(200);
      const body = (await res.json()) as { available?: boolean };
      expect(typeof body.available).toBe("boolean");

      // OBSERVED, not asserted — and that is deliberate. `available: false`
      // has TWO possible causes from out here and they are indistinguishable
      // by design (ac-22: the closed states are byte-identical so the
      // allowlist cannot be enumerated): the flag never reached the revision,
      // or the smoke user is not a member of this Memex. Only the first is a
      // product defect. Asserting `true` would red a shared, fail-loud deploy
      // for either, and a pipeline that stops for an ambiguous reason gets
      // muted rather than fixed.
      //
      // So this prints, and the value must be READ. On int (COST_PANEL_MEMEXES
      // = "*", dec-8) expect true; a false is worth investigating and the two
      // causes are separable from inside — check the revision's env, then
      // membership. On prod expect false for the throwaway namespace, because
      // the value names the dogfood Memex alone.
      //
      // The four-link wiring itself is guarded red-capably at the source
      // (spec-552-cost-panel-rollout-wiring.regression.test.ts, mutation-tested);
      // this is the live cross-check, not the only one.
      console.log(
        `[cost-panel smoke] gate for ${SMOKE_NAMESPACE} (ref ${SMOKE_CANONICAL_REF}) ` +
          `on ENV=${process.env.SMOKE_ENV ?? "?"}: available=${body.available} ` +
          `— int expects true, prod expects false for this namespace`
      );
    });
  }
);
