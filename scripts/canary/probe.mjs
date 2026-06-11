#!/usr/bin/env node
// spec-243: continuous canary — three fast probes against one live environment.
//
// Usage: node scripts/canary/probe.mjs <prod|int>
//
// Probes (dec-3):
//   page      GET  <base>/                      → 200 after redirects
//   emission  POST <base>/api/test-events       → 201 (hidden:true, real key)
//   mcp_read  POST <base>/mcp  tools/call       → result present (real mxt_ token)
//
// Each probe does the smallest REAL authenticated unit of work. /health-style
// pings are deliberately absent: the 2026-06-10 outage returned 200 on every
// public surface all day while every authenticated emission 401'd.
//
// A missing credential is a FAILURE, not a skip. std-17's authed smoke tier
// silently skipping (describe.skipIf(!SMOKE_MCP_TOKEN)) is part of how the
// 2026-06-10 outage stayed dark for 12 hours; the canary does not repeat that.
//
// Output: human lines to stderr, one JSON summary line to stdout, and (when
// running in GitHub Actions) the summary written to $GITHUB_OUTPUT as
// `results`. Exit code 0 = all probes green, 1 = at least one red.

const ENVS = {
  prod: {
    baseUrl: "https://memex.ai",
    emitKeyVar: "CANARY_EMIT_KEY_PROD",
    mcpTokenVar: "CANARY_MCP_TOKEN_PROD",
    acUidVar: "CANARY_AC_UID_PROD",
  },
  int: {
    baseUrl: "https://int.memex.ai",
    emitKeyVar: "CANARY_EMIT_KEY_INT",
    mcpTokenVar: "CANARY_MCP_TOKEN_INT",
    acUidVar: "CANARY_AC_UID_INT",
  },
};

const PROBE_TIMEOUT_MS = 10_000;
// One in-run retry after a short pause absorbs transient 5xx/network blips
// (dec-4); the retry's result is what counts.
const RETRY_DELAY_MS = 10_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function timedFetch(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    return { status: res.status, text, ms: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

function snippet(text) {
  return (text ?? "").replace(/\s+/g, " ").slice(0, 200);
}

// ── The three probes. Each returns {ok, detail} and throws nothing. ─────────

async function probePage(cfg) {
  const res = await timedFetch(`${cfg.baseUrl}/`, { redirect: "follow" });
  return {
    ok: res.status === 200,
    detail: `GET / → ${res.status} (${res.ms}ms)`,
    body: res.status === 200 ? "" : snippet(res.text),
  };
}

async function probeEmission(cfg, env) {
  const key = process.env[cfg.emitKeyVar];
  if (!key) {
    return { ok: false, detail: `missing credential ${cfg.emitKeyVar}`, body: "" };
  }
  const acUid = process.env[cfg.acUidVar];
  if (!acUid) {
    return { ok: false, detail: `missing config ${cfg.acUidVar}`, body: "" };
  }
  const res = await timedFetch(`${cfg.baseUrl}/api/test-events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      ac_uid: acUid,
      status: "pass",
      hidden: true,
      test_identifier: "canary/probe.mjs",
      run_id: `canary-${env}-${process.env.GITHUB_RUN_ID ?? "local"}`,
      metadata: { source: "spec-243 canary", env },
    }),
  });
  return {
    ok: res.status === 201,
    detail: `POST /api/test-events → ${res.status} (${res.ms}ms)`,
    body: res.status === 201 ? "" : snippet(res.text),
  };
}

async function probeMcpRead(cfg) {
  const token = process.env[cfg.mcpTokenVar];
  if (!token) {
    return { ok: false, detail: `missing credential ${cfg.mcpTokenVar}`, body: "" };
  }
  // mxt_ tokens are user-scoped, not Memex-scoped — so the read must name the
  // canary Memex explicitly. Derive `<namespace>/<memex>` from the ac_uid the
  // emission probe already targets; one config value drives both probes.
  const acUid = process.env[cfg.acUidVar] ?? "";
  const canaryMemex = acUid.split("/").slice(0, 2).join("/");
  if (!canaryMemex.includes("/")) {
    return { ok: false, detail: `cannot derive canary memex from ${cfg.acUidVar}`, body: "" };
  }
  const res = await timedFetch(`${cfg.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "list_docs", arguments: { memex: canaryMemex } },
    }),
  });
  // The MCP streamable-HTTP transport may reply as plain JSON OR an SSE frame
  // (same handling as __smoke__/smoke-env.ts callMcpTool).
  let body = {};
  try {
    const dataLine = res.text.split("\n").find((l) => l.startsWith("data:"));
    body = JSON.parse(dataLine ? dataLine.slice(5).trim() : res.text);
  } catch {
    body = {};
  }
  const ok = res.status === 200 && body.result !== undefined && body.error === undefined;
  return {
    ok,
    detail: `POST /mcp list_docs → ${res.status}${body.error ? ` rpc-error: ${snippet(JSON.stringify(body.error))}` : ""} (${res.ms}ms)`,
    body: ok ? "" : snippet(res.text),
  };
}

const PROBES = [
  ["page", probePage],
  ["emission", probeEmission],
  ["mcp_read", probeMcpRead],
];

async function runProbe(name, fn, cfg, env) {
  let result;
  try {
    result = await fn(cfg, env);
  } catch (err) {
    result = { ok: false, detail: `threw: ${snippet(String(err))}`, body: "" };
  }
  if (result.ok) return result;
  // A missing credential/config is deterministic — retrying can't change it.
  if (result.detail.startsWith("missing ")) return result;
  console.error(`[canary:${env}] ${name} FAILED (${result.detail}) — retrying in ${RETRY_DELAY_MS / 1000}s`);
  await sleep(RETRY_DELAY_MS);
  try {
    return await fn(cfg, env);
  } catch (err) {
    return { ok: false, detail: `threw on retry: ${snippet(String(err))}`, body: "" };
  }
}

async function main() {
  const env = process.argv[2];
  const cfg = ENVS[env];
  if (!cfg) {
    console.error(`usage: probe.mjs <${Object.keys(ENVS).join("|")}>`);
    process.exit(2);
  }

  const results = {};
  for (const [name, fn] of PROBES) {
    const r = await runProbe(name, fn, cfg, env);
    results[name] = { ok: r.ok, detail: r.detail, body: r.body ?? "" };
    console.error(`[canary:${env}] ${r.ok ? "✅" : "❌"} ${name}: ${r.detail}`);
  }

  const allOk = Object.values(results).every((r) => r.ok);
  const summary = { env, ok: allOk, results };
  console.log(JSON.stringify(summary));

  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import("node:fs");
    appendFileSync(process.env.GITHUB_OUTPUT, `results=${JSON.stringify(summary)}\n`);
  }

  process.exit(allOk ? 0 : 1);
}

main();
