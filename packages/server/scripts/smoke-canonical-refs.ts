// b-36 — post-deploy smoke check for the canonical-refs hard switch.
//
// Run AFTER the deploy lands. Hits the live /mcp endpoint twice:
//   1. A canonical ref call (e.g. get_doc with the b-36 ref) must succeed
//      and the response must lead with `ref:`. UUIDs must NOT appear in the
//      response payload.
//   2. A UUID-shaped input must come back as the structured error
//      "UUID inputs no longer accepted".
//
// Exits 0 on both passing, non-zero with a per-check message on failure.
// Manual operator tool — not wired into CI.
//
// NOTE (b-70): these two checks are now also folded into the vitest smoke suite's
// AUTHED tier — `packages/server/src/__smoke__/authed.smoke.test.ts`. This script
// remains as a thin, exit-code-based operator tool for ad-hoc runs.
//
// Usage:
//   ENV=int  MEMEX_MCP_TOKEN=mxt_xxx... pnpm --filter @memex/server smoke:canonical-refs
//   ENV=prod MEMEX_MCP_TOKEN=mxt_xxx... pnpm --filter @memex/server smoke:canonical-refs
//
//   # All env vars derive sensible defaults from ENV (default `int`):
//   #   MEMEX_MCP_URL   → https://{int.memex.ai|memex.ai}/mcp   (per ENV)
//   #   MEMEX_SMOKE_REF → the founding spec b-1 in each env's namespace (per ENV)
//   #   MEMEX_MCP_TOKEN → REQUIRED, no default (mint at /settings/tokens)
//
// Per-env hosts/refs match scripts/deploy-config.sh + src/__smoke__/smoke-env.ts.
// The old default (`mindset-int/memex-app/briefs/b-36`, prod MCP URL) was stale
// post the b-65 int→prod migration and is de-drifted here.

const ENV = process.env.ENV ?? "int";
const IS_PROD = ENV === "prod";

const MCP_URL =
  process.env.MEMEX_MCP_URL ??
  (IS_PROD ? "https://memex.ai/mcp" : "https://int.memex.ai/mcp");
const TOKEN = process.env.MEMEX_MCP_TOKEN;
const SMOKE_REF =
  process.env.MEMEX_SMOKE_REF ??
  (IS_PROD
    ? "mindset-prod/memex-building-itself/briefs/b-1"
    : "mindset-int/memex-app/briefs/b-1");
// A throwaway UUID — shape only matters; the call must be rejected at the
// boundary before any DB lookup.
const SMOKE_UUID = "00000000-0000-4000-8000-000000000000";

const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

interface McpResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  error?: { code?: number; message?: string };
}

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ status: number; body: McpResponse; raw: string }> {
  if (!TOKEN) {
    throw new Error(
      "MEMEX_MCP_TOKEN is required. Mint one at /settings/tokens.",
    );
  }

  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });

  const raw = await res.text();
  // The MCP transport replies either as JSON or as a single SSE `data:` line.
  let body: McpResponse;
  if (raw.startsWith("data:")) {
    const dataLine = raw.split("\n").find((l) => l.startsWith("data:")) ?? "";
    body = JSON.parse(dataLine.slice(5).trim()) as McpResponse;
  } else {
    body = JSON.parse(raw) as McpResponse;
  }
  return { status: res.status, body, raw };
}

function textPayload(body: McpResponse): string {
  return (body.result?.content ?? [])
    .map((c) => c.text ?? "")
    .join("\n");
}

async function checkCanonicalRefSucceeds(): Promise<string | null> {
  const { status, body } = await callTool("get_doc", { ref: SMOKE_REF });
  if (status !== 200) return `expected 200, got ${status}`;
  if (body.error) return `unexpected JSON-RPC error: ${body.error.message}`;
  if (body.result?.isError)
    return `tool returned isError=true: ${textPayload(body)}`;

  const text = textPayload(body);
  if (!text) return "empty response payload";
  if (!/\bref:/i.test(text))
    return `response missing \`ref:\` line — first 200 chars: ${text.slice(0, 200)}`;
  if (UUID_RE.test(text))
    return `response contains a UUID (should be ref-only): ${text.match(UUID_RE)?.[0]}`;
  return null;
}

async function checkUuidInputRejected(): Promise<string | null> {
  const { body } = await callTool("get_doc", { ref: SMOKE_UUID });
  const msg = body.error?.message ?? textPayload(body);
  const isError = !!body.error || body.result?.isError === true;
  if (!isError)
    return `expected a structured error for UUID input, got success: ${msg}`;
  if (!/UUID inputs no longer accepted/i.test(msg))
    return `expected "UUID inputs no longer accepted" in error, got: ${msg}`;
  return null;
}

async function main(): Promise<void> {
  console.log(`[b-36 smoke] url=${MCP_URL} ref=${SMOKE_REF}`);

  const failures: string[] = [];

  console.log("  check 1: canonical ref call succeeds and emits `ref:`...");
  try {
    const fail = await checkCanonicalRefSucceeds();
    if (fail) {
      failures.push(`canonical-ref-call: ${fail}`);
      console.log(`    ✗ ${fail}`);
    } else {
      console.log("    ✓ passed");
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    failures.push(`canonical-ref-call (threw): ${reason}`);
    console.log(`    ✗ threw: ${reason}`);
  }

  console.log("  check 2: UUID input returns structured error...");
  try {
    const fail = await checkUuidInputRejected();
    if (fail) {
      failures.push(`uuid-rejection: ${fail}`);
      console.log(`    ✗ ${fail}`);
    } else {
      console.log("    ✓ passed");
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    failures.push(`uuid-rejection (threw): ${reason}`);
    console.log(`    ✗ threw: ${reason}`);
  }

  if (failures.length === 0) {
    console.log("\n[b-36 smoke] all checks passed.");
    process.exit(0);
  }

  console.error(`\n[b-36 smoke] FAILED — ${failures.length} check(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}

main().catch((err) => {
  console.error("[b-36 smoke] fatal:", err);
  process.exit(1);
});
