import { test, expect, bareUrl, emitAcEvents } from "./helpers/index.js";
import { seedOrgTenant } from "./helpers/retained.js";
import {
  clearAnthropicQueue,
  queueAnthropicResponse,
} from "./helpers/anthropic-fake.js";

// spec-230 — in-app Spec creation reaches web ↔ MCP parity: a substantial input
// fleshes out into a RICH, multi-section Spec (sections + decision + AC) and the
// user lands ON the populated Spec; a vague one-liner stays LIGHT (overview only).
//
// The Anthropic SDK is the ONLY faked seam (MEMEX_ANTHROPIC_FAKE=1) — the
// create_doc / add_section / create_decision / create_ac tools execute for real
// against a freshly seeded, isolated memex, so the authored sections/decision/AC
// are genuine server state. Because the memex is fresh, the first created Spec is
// deterministically `spec-1` (nextSpecHandle is per-memex), which lets us pre-queue
// the authoring turns with a known ref.
//
// Scope boundary (honest): with a faked model the journey proves the PLUMBING —
// the creation loop continues past create_doc, executes real authoring tools, and
// the modal lands the user on the populated Spec (rich) vs. stops at a light Spec
// (vague). The model's input-driven JUDGMENT (deciding a substantial doc warrants
// richness) is the prompt's job and is pinned by system-prompt.creation-parity
// (ac-8); it is not faked here.

const SPEC230 = "mindset-prod/memex-building-itself/specs/spec-230";
const AC_RICH = `${SPEC230}/acs/ac-11`; // paste → rich, lands on Spec
const AC_NAV = `${SPEC230}/acs/ac-9`; // loop continues + navigates
const AC_LIGHT = `${SPEC230}/acs/ac-4`; // vague → light, no stub scaffolding

const SUBSTANTIAL_DOC = [
  "# Realtime Presence PRD",
  "",
  "## Problem",
  "Users can't tell who else is viewing a document. We need live presence.",
  "",
  "## Goals",
  "- Show avatars of active viewers in the doc header.",
  "- Sub-second join/leave updates over the existing SSE bus.",
  "- No new infrastructure; reuse the mutation bus.",
  "",
  "## Design",
  "Avatar stack in the header, overflow collapses to a +N pill.",
  "",
  "## Architecture",
  "A presence channel keyed by docId on the SSE bus; ephemeral, not persisted.",
  "",
  "## Open questions",
  "- Do we debounce rapid focus/blur churn server-side or client-side?",
].join("\n");

test.describe("spec-230 — in-app creation reaches MCP parity (rich vs light)", () => {
  test.afterEach(async ({}, testInfo) => {
    await emitAcEvents(
      [AC_RICH, AC_NAV, AC_LIGHT],
      testInfo.status === "passed" ? "pass" : "fail",
      `packages/ui/e2e/journey-26-creation-parity.spec.ts::${testInfo.title}`,
      testInfo.duration,
    );
  });

  test("a substantial document fleshes out into a rich, multi-section Spec the user lands on", async ({
    page,
  }) => {
    const tenant = await seedOrgTenant({
      slug: "spec230-rich",
      ownerEmail: "dev@memex.ai",
      memexSlug: "creation",
    });
    const specRef = `${tenant.namespaceSlug}/${tenant.memexSlug}/specs/spec-1`;

    // Bootstrap the dev session, then land on the seeded memex's Specs board.
    await page.goto(bareUrl("/"), { waitUntil: "commit" });
    await page.goto(
      bareUrl(`/${tenant.namespaceSlug}/${tenant.memexSlug}/specs`),
    );
    await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible({
      timeout: 15_000,
    });

    // Queue the agent's authoring turns. Turn 1 creates the Spec; turns 2–5 flesh
    // it out (two body sections + a decision + a scope AC) against the real spec-1;
    // turn 6 is the closing hand-off text. This is exactly the MCP authoring shape.
    await clearAnthropicQueue();
    await queueAnthropicResponse({
      textDeltas: [],
      content: [
        {
          type: "tool_use",
          id: "c230_create",
          name: "create_doc",
          input: {
            title: "Realtime Presence",
            purpose:
              "Live presence: show who is viewing a document, in real time, over the existing SSE bus.",
            docType: "spec",
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
          id: "c230_design",
          name: "add_section",
          input: {
            ref: specRef,
            sectionType: "design",
            title: "Design",
            content:
              "Avatar stack in the doc header; overflow collapses to a +N pill.",
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
          id: "c230_arch",
          name: "add_section",
          input: {
            ref: specRef,
            sectionType: "architecture",
            title: "Architecture",
            content:
              "Ephemeral presence channel keyed by docId on the SSE bus; not persisted.",
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
          id: "c230_dec",
          name: "create_decision",
          input: {
            ref: specRef,
            title: "Debounce focus/blur churn client-side or server-side?",
            context: "Rapid focus/blur could flood the bus.",
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
          id: "c230_ac",
          name: "create_ac",
          input: {
            ref: specRef,
            kind: "scope",
            statement:
              "Active viewers' avatars appear in the doc header within one second of joining.",
          },
        },
      ],
      stopReason: "tool_use",
    });
    await queueAnthropicResponse({
      textDeltas: ["Your Spec is ready — I've drafted the Design, Architecture, a decision, and an acceptance criterion."],
      content: [
        {
          type: "text",
          text: "Your Spec is ready — I've drafted the Design, Architecture, a decision, and an acceptance criterion.",
        },
      ],
      stopReason: "end_turn",
    });

    // Open the New Spec modal and hand it the substantial document.
    await page.getByRole("button", { name: "+ New Spec" }).click();
    const modalInput = page.getByPlaceholder(/Describe the spec/i);
    await expect(modalInput).toBeVisible();
    await modalInput.fill(SUBSTANTIAL_DOC);
    await modalInput.press("Enter");

    // The loop continues PAST create_doc — every authoring tool ran for real
    // (collapsed success markers), and none errored.
    await expect(page.getByText("Ran create_doc")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Ran add_section").first()).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Ran create_decision")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Ran create_ac")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/^Error:/)).toHaveCount(0);
    await page.screenshot({ path: "test-results/spec230-rich-1-authored.png" });

    // No dead-end: a primary "Open Spec" lands the user on the populated Spec.
    const openSpec = page.getByRole("button", { name: /Open Spec/i });
    await expect(openSpec).toBeVisible({ timeout: 15_000 });
    await openSpec.click();

    await expect(page).toHaveURL(/\/specs\/spec-1$/, { timeout: 15_000 });
    // The Spec is RICH — the authored body sections render (DocOutline lists them).
    await expect(page.getByText("Realtime Presence").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Design").first()).toBeVisible();
    await expect(page.getByText("Architecture").first()).toBeVisible();
    await page.screenshot({ path: "test-results/spec230-rich-2-populated-spec.png", fullPage: true });
  });

  test("a vague one-liner stays a light Spec — no force-scaffolded stub sections", async ({
    page,
  }) => {
    const tenant = await seedOrgTenant({
      slug: "spec230-light",
      ownerEmail: "dev@memex.ai",
      memexSlug: "creation",
    });

    await page.goto(bareUrl("/"), { waitUntil: "commit" });
    await page.goto(
      bareUrl(`/${tenant.namespaceSlug}/${tenant.memexSlug}/specs`),
    );
    await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible({
      timeout: 15_000,
    });

    // A vague one-liner: the agent creates the Overview and stops — no extra
    // authoring turns, so no stub sections are force-scaffolded (the spec-5
    // Issue-4 guardrail still holds).
    await clearAnthropicQueue();
    await queueAnthropicResponse({
      textDeltas: [],
      content: [
        {
          type: "tool_use",
          id: "c230_light_create",
          name: "create_doc",
          input: {
            title: "Maybe improve onboarding",
            purpose: "A vague idea to revisit onboarding at some point.",
            docType: "spec",
          },
        },
      ],
      stopReason: "tool_use",
    });
    await queueAnthropicResponse({
      textDeltas: ["Created a light Spec — add detail whenever you're ready."],
      content: [
        { type: "text", text: "Created a light Spec — add detail whenever you're ready." },
      ],
      stopReason: "end_turn",
    });

    await page.getByRole("button", { name: "+ New Spec" }).click();
    const modalInput = page.getByPlaceholder(/Describe the spec/i);
    await expect(modalInput).toBeVisible();
    await modalInput.fill("maybe we should improve onboarding someday");
    await modalInput.press("Enter");

    // create_doc ran; the loop did NOT author any sections/decisions/ACs.
    await expect(page.getByText("Ran create_doc")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: /Open Spec/i })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Ran add_section")).toHaveCount(0);
    await expect(page.getByText("Ran create_decision")).toHaveCount(0);
    await expect(page.getByText("Ran create_ac")).toHaveCount(0);
    await page.screenshot({ path: "test-results/spec230-light-1-overview-only.png" });
  });
});
