import {
  test,
  expect,
  tenantPath,
  bareUrl,
  emitAcEvents,
} from "./helpers/index.js";
import type { Page } from "@playwright/test";
import { seedOrgTenant } from "./helpers/retained.js";
import {
  clearAnthropicQueue,
  queueAnthropicResponse,
} from "./helpers/anthropic-fake.js";

// The shared `sendChat` helper targets the spec-mode placeholder ("Ask me
// anything"); the SCOPED standards agent uses "Ask about the Standards…", so we
// drive its input by its stable testid instead (mode-agnostic).
async function sendToStandardsAgent(page: Page, text: string): Promise<void> {
  const input = page.getByTestId("chat-input");
  await input.waitFor({ state: "visible", timeout: 15_000 });
  await input.fill(text);
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeEnabled({ timeout: 10_000 });
  await send.click();
}

// Journey 59 — spec-416 (std-28): the in-app standards agent can CREATE a brand-new
// standard from scratch (not just edit existing ones), gated by render_confirmation.
//
// This is the ac-1 e2e gap the spec-416 QA report flagged ("if/when the agent-chat
// e2e harness is in place") — the harness IS in place (the deterministic Anthropic
// fake, MEMEX_ANTHROPIC_FAKE=1). It drives the FULL in-app flow that no unit test can:
// Standards-page chat → LLM tool-call loop → render_confirmation gate → the user
// confirms → the `create_standard` handler mints a real standard → it appears on the
// Standards list. Mirrors journey-55's skills-agent drive.
//
// The mechanism (create_standard present in standards mode; the gated mint path) is
// already unit-verified by ac-5/ac-6; this closes ac-1 — the user-facing outcome —
// at the browser level. Runs against the real Standards service on a cold DB (no SQL).
//
//   ac-1 — a user on the Standards page asks the standards agent to create a
//           brand-new standard and it does so (title + opening rule), WITHOUT
//           handing off to another agent.
//   ac-2 — creation goes through the render_confirmation gate: cancelling the
//           proposal mints NOTHING (a standard is never created without an
//           explicit user confirmation).

const SPEC = "mindset-prod/memex-building-itself/specs/spec-416";
const AC_1 = `${SPEC}/acs/ac-1`;
const AC_2 = `${SPEC}/acs/ac-2`;

const ACS_BY_TEST: Record<string, string[]> = {};

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  const acRefs = ACS_BY_TEST[testInfo.title] ?? [];
  if (acRefs.length === 0) return;
  await emitAcEvents(
    acRefs,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-59-spec-416-standards-agent-create.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

const TITLE =
  "a user asks the Standards-page agent to create a new standard — it proposes via render_confirmation, and on confirm mints it via create_standard (ac-1)";
ACS_BY_TEST[TITLE] = [AC_1];

test(TITLE, async ({ page, resources }) => {
  // Fresh org tenant owned by the auto-authed dev user, so dev opens the Memex as a
  // writing administrator and the Standards list starts empty (org Memexes seed no
  // default standards — spec-438 dec-4 is personal-only). Torn down in afterEach.
  const tenant = await seedOrgTenant({
    slug: resources.slug("spec416-std-agent"),
    ownerEmail: "dev@memex.ai",
    memexSlug: "standards",
  });
  const memexRef = `${tenant.namespaceSlug}/${tenant.memexSlug}`;
  const STANDARD_TITLE = "API responses expose keys in camelCase";

  // The standards agent's create is gated behind render_confirmation (dec-2 / ac-2):
  //   Turn 1: propose the create via render_confirmation (stops for the user click);
  //   Turn 2 (after the user confirms): call create_standard, minting the standard;
  //   Turn 3: confirm in prose once the create round-trips.
  await clearAnthropicQueue();
  await queueAnthropicResponse({
    textDeltas: [],
    content: [
      {
        type: "tool_use",
        id: "toolu_416_confirm",
        name: "render_confirmation",
        input: {
          message: `Create a new standard "${STANDARD_TITLE}"?`,
          confirmLabel: "Create it",
        },
      },
    ],
    stopReason: "tool_use",
  });
  await queueAnthropicResponse({
    textDeltas: [],
    content: [
      {
        type: "tool_use",
        id: "toolu_416_create",
        name: "create_standard",
        input: {
          memex: memexRef,
          title: STANDARD_TITLE,
          purpose:
            "All JSON API responses expose object keys in camelCase, never snake_case.",
        },
      },
    ],
    stopReason: "tool_use",
  });
  await queueAnthropicResponse({
    textDeltas: ["Created ", "the ", `"${STANDARD_TITLE}" `, "standard."],
    content: [
      { type: "text", text: `Created the "${STANDARD_TITLE}" standard.` },
    ],
    stopReason: "end_turn",
  });

  // Land on the Standards page — the standards agent docks in the left rail with a
  // STATIC intro (no opening LLM turn, so it consumes none of the queue).
  await page.goto(bareUrl("/"), { waitUntil: "commit" });
  await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, "/standards"));
  await expect(page.getByTestId("standards-assistant-panel")).toBeVisible({
    timeout: 15_000,
  });
  // The list starts genuinely empty (org tenant, no default standards).
  await expect(page.getByTestId("standard-card")).toHaveCount(0);

  // ── ASK THE AGENT TO CREATE ────────────────────────────────────────────────
  await sendToStandardsAgent(page, `Create a standard: ${STANDARD_TITLE}`);

  // ac-2 gate: the agent proposes the create behind render_confirmation. Confirm it.
  const confirmBtn = page.getByRole("button", { name: "Create it" });
  await expect(confirmBtn).toBeVisible({ timeout: 15_000 });
  await confirmBtn.click();

  // The agent confirms in prose once create_standard has run.
  await expect(page.getByTestId("chat-markdown").last()).toHaveText(
    /Created the .* standard\./,
    { timeout: 15_000 },
  );

  // ac-1: the standard REALLY landed via the create_standard path (not a handoff) —
  // it appears on the Standards list, live via the doc-change SSE the list subscribes
  // to. (No reload: proving the agent's write reached the real service.)
  const card = page
    .getByTestId("standard-card")
    .filter({ hasText: STANDARD_TITLE });
  await expect(card).toHaveCount(1, { timeout: 15_000 });
});

const TITLE_CANCEL =
  "cancelling the render_confirmation proposal mints NOTHING — the standards agent never creates a standard without explicit confirmation (ac-2)";
ACS_BY_TEST[TITLE_CANCEL] = [AC_2];

test(TITLE_CANCEL, async ({ page, resources }) => {
  const tenant = await seedOrgTenant({
    slug: resources.slug("spec416-std-cancel"),
    ownerEmail: "dev@memex.ai",
    memexSlug: "standards",
  });
  const REJECTED_TITLE = "Never-created standard";

  // Turn 1: the agent proposes the create via render_confirmation.
  // Turn 2 (after the user CANCELS): it acknowledges — and crucially never calls
  // create_standard, so nothing is minted.
  await clearAnthropicQueue();
  await queueAnthropicResponse({
    textDeltas: [],
    content: [
      {
        type: "tool_use",
        id: "toolu_416_confirm_cancel",
        name: "render_confirmation",
        input: {
          message: `Create a new standard "${REJECTED_TITLE}"?`,
          confirmLabel: "Create it",
          cancelLabel: "Cancel",
        },
      },
    ],
    stopReason: "tool_use",
  });
  await queueAnthropicResponse({
    textDeltas: ["Okay, ", "I won't ", "create it."],
    content: [{ type: "text", text: "Okay, I won't create it." }],
    stopReason: "end_turn",
  });

  await page.goto(bareUrl("/"), { waitUntil: "commit" });
  await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, "/standards"));
  await expect(page.getByTestId("standards-assistant-panel")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByTestId("standard-card")).toHaveCount(0);

  await sendToStandardsAgent(page, `Create a standard: ${REJECTED_TITLE}`);

  // ac-2 gate: the proposal renders — CANCEL it.
  const cancelBtn = page.getByRole("button", { name: "Cancel" });
  await expect(cancelBtn).toBeVisible({ timeout: 15_000 });
  await cancelBtn.click();

  // The agent acknowledges the cancellation…
  await expect(page.getByTestId("chat-markdown").last()).toHaveText(
    /won't create it\./,
    { timeout: 15_000 },
  );

  // …and NOTHING was minted — the Standards list is still empty. Give any (buggy)
  // stray write a moment to surface, then assert the list stayed empty.
  await expect(page.getByTestId("standard-card")).toHaveCount(0);
});
