// Journey 77 — spec-510 t-9: the guidance cadence, observed over the wire.
//
// WHAT CHANGED FOR A USER. Nothing they can see, and that is the point worth
// stating plainly. spec-510 changes what an AGENT reads after every action: a
// static guidance block arrives in full the first time a session meets it and
// is replaced by an 84-character pointer thereafter. The person watching gets
// the same answers from an agent that spent a fraction of the tokens getting
// there. std-28 earns a journey here because the flow an agent drives IS a
// user-facing flow — it is the one the coding agent runs all day.
//
// ── WHAT THIS JOURNEY PROVES, AND WHAT IT DOES NOT ──────────────────────────
//
// The MCP half is real end-to-end proof: two `get_doc` calls over the actual
// `/mcp` transport on one `Mcp-Session-Id`, asserting full-then-pointer, plus a
// third on a DIFFERENT session id proving the cadence is keyed per session and
// not global. Nothing is stubbed; this is the transport a coding agent uses.
//
// The in-app half is a NON-REGRESSION check, not a cadence assertion, and the
// difference matters. The in-app agent's guidance rides its system prompt to
// Anthropic, and the e2e fake (`MEMEX_ANTHROPIC_FAKE=1`) records only its queue
// length — it does not capture the requests it received. So there is nothing
// here to assert the in-app cadence against without adding a capture facility
// to production-adjacent code purely for a test. That in-app keying is proven
// at the unit tier instead (ac-22: the conversation id is the cadence key, with
// the seat resolving it lazily), and what this journey adds is that a real
// two-turn conversation still works with the cadence ON. Same reasoning the
// cost-panel gate records one file over in playwright.config.ts: prove it at the
// tier that can actually see it.
//
// ⚠ BOTH FLAGS ARE ON FOR THE WHOLE RUN, set in playwright.config.ts. A journey
// cannot flip them mid-run — the server reads its env at boot. And
// `reuseExistingServer` is true locally, so a server left running from before
// that config change has NEITHER flag and this journey would exercise the OFF
// path. The assertions below name that possibility in their failure messages
// rather than leaving the next reader to guess.
//
// Tags ac-1 (full on first sight, pointer thereafter), ac-2 (the dynamic state
// line is never suppressed) and ac-4 (both surfaces, each keyed to its own
// session or thread).

import { test, expect, tenantPath, sendChat } from "./helpers/index.js";
import {
  clearAnthropicQueue,
  queueAnthropicResponse,
} from "./helpers/anthropic-fake.js";
import {
  seedOrgTenant,
  seedSpec,
  setDocStatus,
  type SeededOrgTenant,
} from "./helpers/retained.js";
import { emitAcEvents } from "./helpers/emit-ac.js";

const ACS = [
  "mindset-prod/memex-building-itself/specs/spec-510/acs/ac-1",
  "mindset-prod/memex-building-itself/specs/spec-510/acs/ac-2",
  "mindset-prod/memex-building-itself/specs/spec-510/acs/ac-4",
];

const DEV_MCP_BEARER = "mxt_DEV_LOCAL_ONLY_NEVER_PRODUCTION";
const MCP_URL =
  (process.env.E2E_API_URL ??
    `http://localhost:${process.env.E2E_SERVER_PORT ?? 8090}`) + "/mcp";

/** A phrase that rides the verbose `build` footer and is suppressed under EVERY
 *  option dec-12 is weighing, so this journey survives that decision unchanged
 *  (PR #740 round-6).
 *
 *  It was the classify-and-consult tripwire — long, stable, unambiguous, and
 *  exactly the wrong choice: every dec-12 option keeps the tripwire in FULL, so
 *  asserting its disappearance pinned the opposite of what the Spec is about to
 *  promise. This phrase lives only in the phase-summary / intent / discipline
 *  blocks, all suppressed either way, and in none of the dynamic half. */
const STATIC_MARKER = "Tasks are first-class";
/** The 84-char replacement (CADENCE_POINTER in scaffold-data.ts). */
const POINTER = "guidance shown earlier this session";

const STALE_SERVER_HINT =
  "\n\nIf this is the FIRST assertion to fail, suspect the server before the code: " +
  "playwright.config.ts sets GUIDANCE_CADENCE_ENABLED=1, but reuseExistingServer is " +
  "true locally, so a server started before that change has the flag OFF and emits " +
  "full guidance every time. Kill it and re-run.";

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    ACS,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-77-spec-510-guidance-cadence.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

/** Call a real MCP tool over the wire on a named session, exactly as a coding
 *  agent would. The session header is what the cadence keys on, so it is the
 *  one parameter this journey actually varies. */
async function mcpToolCall(
  request: import("@playwright/test").APIRequestContext,
  sessionId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const res = await request.post(MCP_URL, {
    headers: {
      Authorization: `Bearer ${DEV_MCP_BEARER}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "Mcp-Session-Id": sessionId,
    },
    data: {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    },
  });
  expect(
    res.ok(),
    `MCP ${name} HTTP transport should respond (got ${res.status()})`,
  ).toBeTruthy();
  const text = await res.text();
  const dataLine = text.split("\n").find((l) => l.startsWith("data: "));
  expect(dataLine, `MCP ${name} returned no SSE data: ${text}`).toBeTruthy();
  const payload = JSON.parse(dataLine!.slice(6));
  return String(payload.result?.content?.[0]?.text ?? "");
}

test("a coding agent reads guidance once per session, then a pointer", async ({
  request,
  resources,
}) => {
  const slug = resources.slug("cadence");
  const tenant: SeededOrgTenant = await seedOrgTenant({ slug });
  const spec = await seedSpec({
    memexId: tenant.memexId,
    title: "Cadence Subject",
    purpose: "spec-510 journey subject.",
  });
  // `build` carries the richest static guidance, so the difference between full
  // and suppressed is largest and least ambiguous here.
  await setDocStatus({
    memexId: tenant.memexId,
    docId: spec.docId,
    status: "build",
  });
  const specRef = `${tenant.namespaceSlug}/${tenant.memexSlug}/specs/${spec.handle}`;

  const sessionA = `journey77-${slug}-A`;
  const sessionB = `journey77-${slug}-B`;

  // ── 1. First sight: the guidance arrives in full ──────────────────────────
  const first = await mcpToolCall(request, sessionA, "get_doc", {
    ref: specRef,
    verbose: true,
  });
  expect(
    first,
    `First call in a session must carry the static guidance IN FULL — losing it ` +
      `here would mean an agent never gets primed at all, which is the one ` +
      `failure worse than the verbosity this Spec removes.`,
  ).toContain(STATIC_MARKER);
  expect(first).not.toContain(POINTER);

  // ── 2. Same session: the prose is replaced by one line ────────────────────
  const second = await mcpToolCall(request, sessionA, "get_doc", {
    ref: specRef,
    verbose: true,
  });
  expect(
    second,
    `The second call in the SAME session must replace the guidance prose with a ` +
      `pointer.${STALE_SERVER_HINT}`,
  ).toContain(POINTER);
  expect(second).not.toContain(STATIC_MARKER);

  // The whole point of the Spec, asserted as a size and not just a substring.
  expect(second.length).toBeLessThan(first.length);

  // ── 3. ac-2: the dynamic line is NEVER suppressed ─────────────────────────
  // Suppression applies to STATIC prose only. The per-response state — which
  // phase, what is next — is the one thing an agent cannot reconstruct from an
  // earlier response, because it changes under it. It must survive.
  for (const [label, body] of [
    ["first", first],
    ["second", second],
  ] as const) {
    expect(
      body,
      `The ${label} response lost the dynamic state line. The cadence may only ` +
        `suppress STATIC blocks; the state line is per-response and cannot be ` +
        `recovered from anything the agent read earlier (ac-2).`,
    ).toMatch(/spec-\d+ · build/);
  }

  // The reference must read as a reference, never as a fault (Design & UX lens).
  expect(second).not.toMatch(/⚠|omitted|truncated/);

  // ── 4. ac-4: keyed per session, not globally ──────────────────────────────
  // A second agent opening its own session has read nothing yet and must be
  // primed in full. If this returned the pointer, the cadence would be leaking
  // across sessions and new agents would start blind.
  const otherSession = await mcpToolCall(request, sessionB, "get_doc", {
    ref: specRef,
    verbose: true,
  });
  expect(
    otherSession,
    `A DIFFERENT session must be primed in full — suppression keyed anything ` +
      `wider than the session would leave a fresh agent reading a pointer to ` +
      `guidance it has never seen.`,
  ).toContain(STATIC_MARKER);
  expect(otherSession).not.toContain(POINTER);
});

test("the in-app agent still holds a two-turn conversation with the cadence on", async ({
  page,
  resources,
}) => {
  // NON-REGRESSION, stated as such above: this asserts the in-app surface is not
  // broken by the cadence, not that the in-app cadence fires. The fake Anthropic
  // does not record what it was sent, so the guidance itself is unobservable
  // from here; ac-22 proves the conversation-id keying at the unit tier.
  const slug = resources.slug("cadence-ui");
  const tenant = await seedOrgTenant({ slug });
  const { docId } = await seedSpec({
    memexId: tenant.memexId,
    title: "Cadence UI Subject",
    purpose: "The agent should answer twice in one thread.",
  });

  await clearAnthropicQueue();
  await queueAnthropicResponse({
    textDeltas: ["First ", "answer."],
    content: [{ type: "text", text: "First answer." }],
    stopReason: "end_turn",
  });
  await queueAnthropicResponse({
    textDeltas: ["Second ", "answer."],
    content: [{ type: "text", text: "Second answer." }],
    stopReason: "end_turn",
  });

  await page.goto(
    tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/docs/${docId}`),
  );
  await expect(page.getByText(/The agent should answer twice/)).toBeVisible({
    timeout: 15_000,
  });

  await sendChat(page, "First question?");
  await expect(page.getByTestId("chat-markdown").first()).toHaveText(
    /First answer\./,
    { timeout: 10_000 },
  );

  // The SECOND turn is the one that matters: it is the call on which the cadence
  // suppresses, so a defect in the suppression path would surface here as a
  // turn that never completes rather than as a smaller payload.
  await sendChat(page, "Second question?");
  await expect(page.getByTestId("chat-markdown").nth(1)).toHaveText(
    /Second answer\./,
    { timeout: 10_000 },
  );
});
