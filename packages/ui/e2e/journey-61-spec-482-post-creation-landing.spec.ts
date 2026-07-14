import { test, expect, tenantPath, emitAcEvents } from "./helpers/index.js";
import { seedOrgTenant } from "./helpers/retained.js";
import {
  clearAnthropicQueue,
  queueAnthropicResponse,
} from "./helpers/anthropic-fake.js";

// Journey 61 (spec-482): the post-creation landing (std-28 gate).
//
// After a user creates a Spec through the in-app creation flow they land DIRECTLY
// on the newly-created Spec's document view — not the Kanban board, not a closed
// dialogue — with the agent panel (ChatPanel) open. Post-t-12 there is NO persistent
// handoff card (dec-7 revised — it duplicated the agent's own recap and was ditched);
// the agent instead delivers the MCP handoff conversationally, emitting any copyable
// text through a `render_handoff` Copy-button block (std-34/std-38).
//
// This journey asserts the DETERMINISTIC user-facing outcome: the land-on-the-Spec
// hop with the agent panel present (ac-3). It deliberately does NOT assert the agent's
// render_handoff output here: the create flow (NewSpecModal, /chat/create) and the
// landing chat (/llm/chat) share ONE FIFO fake-Anthropic queue, and both agent loops
// drain it until a text turn — with navigation aborting the create loop at a
// non-deterministic point. There is no fixed queue layout that guarantees exactly one
// handoff on the landing turn (the abort point shifts which queued response the landing
// consumes). ac-5 (the handoff is delivered via a render_handoff Copy button, never
// inline) is instead covered DETERMINISTICALLY by unit tests: the connect-tier opening
// posture in system-prompt.spec-482.test.ts (the agent is instructed to use
// render_handoff) and the render_handoff renderer itself in Handoff.test.tsx (the Copy
// button copies the prompt).
//
// The seam under test:
//   • The ONBOARDING entry — a `/specs?new=1` deep-link (spec-482 dec-4, ac-24) —
//     auto-opens the NewSpecModal with `openOnCreate` set (SpecList strips the param).
//     The board's own "+ New Spec" button deliberately does NOT auto-land: it keeps
//     spec-230's manual "Open Spec" footer (journey-26). So this journey enters via
//     `?new=1`, never the button.
//   • With openOnCreate set, a confirmed create navigates to `/specs/<handle>` with
//     React-Router `state:{creationLanding:true}` (NewSpecModal.openSpec) — no
//     "Open Spec" click, no dead-end dialogue.
//
// The Anthropic SDK is the ONLY faked seam (MEMEX_ANTHROPIC_FAKE=1): create_doc runs
// for real against a freshly seeded, isolated memex, so the first Spec is
// deterministically `spec-1` (nextSpecHandle is per-memex).
//
// Emits spec-482 ac-3 (land directly on the created Spec's doc view with the agent
// panel present).

const SPEC482 = "mindset-prod/memex-building-itself/specs/spec-482";
const AC_LAND = `${SPEC482}/acs/ac-3`; // land on the Spec doc view, agent panel open

const FILE = "packages/ui/e2e/journey-61-spec-482-post-creation-landing.spec.ts";

const TITLE =
  "creating a Spec via the onboarding entry lands the user directly on its doc view with the agent panel open (ac-3)";

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    [AC_LAND],
    testInfo.status === "passed" ? "pass" : "fail",
    `${FILE}::${testInfo.title}`,
    testInfo.duration,
  );
});

test(TITLE, async ({ page, resources }) => {
  // A fresh org memex — its first created Spec is deterministically spec-1.
  const tenant = await seedOrgTenant({ slug: resources.slug("j61") });

  // Enter creation the ONBOARDING way: the `?new=1` deep-link (spec-482 dec-4,
  // ac-24). SpecList reads it, auto-opens the NewSpecModal with openOnCreate set,
  // and strips the param. This is the ONLY entry that auto-lands on the Spec — the
  // board's "+ New Spec" button keeps spec-230's manual footer, so we do NOT click it.
  await page.goto(
    tenantPath(tenant.namespaceSlug, tenant.memexSlug, "/specs?new=1"),
    { waitUntil: "commit" },
  );

  // Queue the agent turns. Turn 1 is create_doc, which mints spec-1. The create flow
  // and the landing opening turn then drain the shared queue until a text turn; we
  // append a couple of harmless text end_turns so whichever turn runs completes
  // cleanly. This journey asserts only the nav-driven landing (ac-3), so the exact
  // agent output on the landing turn is immaterial (see the header note on ac-5).
  await clearAnthropicQueue();
  await queueAnthropicResponse({
    textDeltas: [],
    content: [
      {
        type: "tool_use",
        id: "c482_create",
        name: "create_doc",
        input: {
          title: "Realtime Presence",
          purpose:
            "Show who is viewing a document, in real time, over the existing SSE bus.",
          docType: "spec",
        },
      },
    ],
    stopReason: "tool_use",
  });
  for (let i = 0; i < 2; i++) {
    await queueAnthropicResponse({
      textDeltas: ["Your Spec is ready."],
      content: [{ type: "text", text: "Your Spec is ready." }],
      stopReason: "end_turn",
    });
  }

  // The ?new=1 deep-link already auto-opened the modal — describe the Spec.
  const modalInput = page.getByPlaceholder(/Describe the spec/i);
  await expect(modalInput).toBeVisible({ timeout: 15_000 });
  await modalInput.fill("A live presence indicator showing who is viewing a doc.");
  await modalInput.press("Enter");

  // ── ac-3: the user lands DIRECTLY on the created Spec's doc view ──────────────
  // openOnCreate auto-navigates to `/specs/spec-1` on the confirmed create — no
  // "Open Spec" click, and the creation modal (a full-screen dialogue) is gone.
  await expect(page).toHaveURL(/\/specs\/spec-1$/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "New Spec" })).toHaveCount(0);

  // …with the agent panel (ChatPanel) present and open — its "Spec assistant"
  // heading is the reliable panel-mounted anchor (journey-31 pattern).
  await expect(page.getByText("Spec assistant")).toBeVisible({ timeout: 15_000 });
});
