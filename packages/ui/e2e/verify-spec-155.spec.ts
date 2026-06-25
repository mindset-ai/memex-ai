import { test, expect, bareUrl } from "./helpers/index.js";
import { getPersonalMemexByEmail, setUserName, deleteDoc } from "./helpers/index.js";
import {
  clearAnthropicQueue,
  queueAnthropicResponse,
} from "./helpers/anthropic-fake.js";

// One-off live verification for spec-155 (ac-1 / ac-2).
// The Anthropic SDK is the ONLY faked seam (the repo's deterministic queue
// double, MEMEX_ANTHROPIC_FAKE=1). The create_doc tool executes against the
// real server, which returns the real `Spec created: ref: …` string; the real
// client parser (extractDocInfo) must recognise it, fire onDocCreated, flip
// NewSpecModal into its closed state, and the real SSE bus must surface the
// new card on the Kanban — all without a page reload (proven by a window
// sentinel a refresh would wipe).

const THROWAWAY_TITLE = "Throwaway spec-155 verification";

// The scope ACs this journey verifies. Playwright isn't wired to the
// @memex-ai-ac/vitest helper, so we port the wire format per the ac-emission
// doc: POST to the ref's canonical host (mindset-prod → memex.ai), pass and
// fail alike.
const SPEC155 = "mindset-prod/memex-building-itself/specs/spec-155";
const SCOPE_ACS = [`${SPEC155}/acs/ac-1`, `${SPEC155}/acs/ac-2`];

async function emitAcEvents(
  status: "pass" | "fail",
  testIdentifier: string,
  durationMs: number
): Promise<void> {
  if (/^(false|0|no|off)$/i.test(process.env.MEMEX_EMIT ?? "")) return;
  for (const ac_uid of SCOPE_ACS) {
    await fetch("https://memex.ai/api/test-events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ac_uid,
        status,
        test_identifier: testIdentifier,
        duration_ms: durationMs,
        actor: process.env.USER,
      }),
    });
  }
}

test.describe("spec-155 — agent-created Spec, live", () => {
  let createdDocId: string | null = null;

  test.afterEach(async ({}, testInfo) => {
    if (createdDocId) await deleteDoc(createdDocId);
    await emitAcEvents(
      testInfo.status === "passed" ? "pass" : "fail",
      `packages/ui/e2e/verify-spec-155.spec.ts::${testInfo.title}`,
      testInfo.duration
    );
  });

  test("agent-created Spec closes the modal and lands on the Kanban without refresh", async ({
    page,
  }) => {
    // First visit bootstraps the dev session server-side (creates the personal
    // namespace + memex if absent) — poll until it exists, then name the user
    // so the onboarding profile screen is skipped on the next load.
    // waitUntil: "commit" — PostLoginRouter may client-redirect mid-load,
    // which aborts a default ("load") goto.
    await page.goto(bareUrl("/"), { waitUntil: "commit" });
    let memex = null;
    for (let i = 0; i < 30 && !memex; i++) {
      memex = await getPersonalMemexByEmail("dev@memex.ai");
      if (!memex) await page.waitForTimeout(500);
    }
    if (!memex) throw new Error("dev@memex.ai personal memex never appeared after bootstrap");
    await setUserName("dev@memex.ai", "Dev User");

    // Turn 1: the model "decides" to create the Spec. Turn 2: follow-up text
    // after the (real) tool_result comes back.
    await clearAnthropicQueue();
    await queueAnthropicResponse({
      textDeltas: [],
      content: [
        {
          type: "tool_use",
          id: "toolu_v155_create",
          name: "create_doc",
          input: {
            title: THROWAWAY_TITLE,
            purpose: "Throwaway purpose for spec-155 in-browser verification.",
            docType: "spec",
          },
        },
      ],
      stopReason: "tool_use",
    });
    await queueAnthropicResponse({
      textDeltas: ["Your spec has been created."],
      content: [{ type: "text", text: "Your spec has been created." }],
      stopReason: "end_turn",
    });

    // Land on the Specs board — navigate to the resolved tenant path directly
    // so we don't race the PostLoginRouter redirect — and plant the no-reload
    // sentinel.
    await page.goto(bareUrl(`/${memex.namespaceSlug}/${memex.memexSlug}/specs`));
    await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible({
      timeout: 15_000,
    });
    const newSpecButton = page.getByRole("button", { name: "+ New Spec" });
    await expect(newSpecButton).toBeVisible({ timeout: 15_000 });
    await page.evaluate(() => {
      (window as unknown as Record<string, unknown>).__verify155 = true;
    });

    // Open the creation modal and send the prompt.
    await newSpecButton.click();
    const modalInput = page.getByPlaceholder(/Describe the spec/i);
    await expect(modalInput).toBeVisible();
    await page.screenshot({ path: "test-results/spec155-1-modal-open.png" });
    await modalInput.fill(`Create a spec titled "${THROWAWAY_TITLE}"`);
    await modalInput.press("Enter");

    // ac-1: the modal transitions to its closed state — the text-entry is
    // replaced by the "ready" notice + Close affordance. (spec-230 t-3 reworded
    // the notice and added a primary "Open Spec"; Close remains as secondary.)
    const closedNotice = page.getByText(/Your spec is ready/i);
    await expect(closedNotice).toBeVisible({ timeout: 15_000 });
    // The modal header's X button also carries aria-label="Close"; the closed
    // state's affordance is the FOOTER Close button (visible text).
    const closeButton = page
      .getByRole("button", { name: "Close" })
      .filter({ hasText: "Close" });
    await expect(closeButton).toBeVisible();
    await expect(modalInput).not.toBeVisible();
    await page.screenshot({ path: "test-results/spec155-2-modal-complete.png" });

    // Dismiss the modal (a click, not a reload) and confirm the new card is
    // already on the board.
    await closeButton.click();
    await expect(closedNotice).not.toBeVisible();

    // ac-2: the card appeared via the SSE-driven refetch, no refresh.
    await expect(page.getByText(THROWAWAY_TITLE).first()).toBeVisible({
      timeout: 15_000,
    });
    await page.screenshot({
      path: "test-results/spec155-3-kanban-card.png",
      fullPage: true,
    });

    // The sentinel survives — the page was never reloaded.
    const sentinel = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__verify155
    );
    expect(sentinel).toBe(true);

    // Guard: the doc really landed server-side (not a cached-state mirage). The
    // card on the Kanban is rendered from the SSE-driven refetch (DocList re-reads
    // the API on `document created`), not local modal state — so its visibility is
    // the server-backed proof. The old raw-SQL count guard is dropped (the e2e
    // package has no Postgres dependency, dec-2). `createdDocId` stays null; this
    // is a one-off live verification against the dev memex, so the throwaway doc is
    // left in place rather than read back over a bespoke SQL channel.
    void createdDocId;

    // Probe: reopen the modal — it must come back in its fresh entry state
    // (text-entry visible again), not stuck in the completed state; Esc closes.
    await page.getByRole("button", { name: "+ New Spec" }).click();
    await expect(page.getByPlaceholder(/Describe the spec/i)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByPlaceholder(/Describe the spec/i)).not.toBeVisible();
  });
});
