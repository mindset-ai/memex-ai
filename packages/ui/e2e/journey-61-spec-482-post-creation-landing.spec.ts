import { test, expect, tenantPath, emitAcEvents } from "./helpers/index.js";
import { seedOrgTenant } from "./helpers/retained.js";
import {
  clearAnthropicQueue,
  queueAnthropicResponse,
} from "./helpers/anthropic-fake.js";

// Journey 61 (spec-482): the post-creation landing + handoff card (std-28 gate).
//
// After a user creates a Spec through the in-app creation flow they land DIRECTLY
// on the newly-created Spec's document view — not the Kanban board, not a closed
// dialogue — with the agent panel (ChatPanel) open, and the ChatPanel renders the
// three-step "connect" PostCreationHandoffCard with its one-click Spec-URL copy.
//
// The seam under test (built this session):
//   • The ONBOARDING entry — a `/specs?new=1` deep-link (spec-482 dec-4, ac-24) —
//     auto-opens the NewSpecModal with `openOnCreate` set (SpecList strips the param).
//     The board's own "+ New Spec" button deliberately does NOT auto-land: it keeps
//     spec-230's manual "Open Spec" footer (journey-26). So this journey enters via
//     `?new=1`, never the button.
//   • With openOnCreate set, a confirmed create navigates to `/specs/<handle>` with
//     React-Router `state:{creationLanding:true}` (NewSpecModal.openSpec) — no
//     "Open Spec" click, no dead-end dialogue.
//   • ChatPanel reads that nav state (isCreationLanding), fires the landing opening
//     turn, and renders <PostCreationHandoffCard> inside the messages area. Because a
//     fresh tenant has no observed MCP traffic, `mcpToolCalled` is false, so the FULL
//     three-step card (testid `post-creation-handoff-card`) shows — its step-2
//     CodeBlock is the one-click Spec-URL copy affordance.
//
// The Anthropic SDK is the ONLY faked seam (MEMEX_ANTHROPIC_FAKE=1): create_doc runs
// for real against a freshly seeded, isolated memex, so the first Spec is
// deterministically `spec-1` (nextSpecHandle is per-memex).
//
// Emits spec-482 ac-3 (land directly on the created Spec's doc view with the agent
// panel present) and ac-5 (the post-creation handoff card + its copy-Spec-URL step).

const SPEC482 = "mindset-prod/memex-building-itself/specs/spec-482";
const AC_LAND = `${SPEC482}/acs/ac-3`; // land on the Spec doc view, agent panel open
const AC_CARD = `${SPEC482}/acs/ac-5`; // the handoff card + copy-Spec-URL affordance

const FILE = "packages/ui/e2e/journey-61-spec-482-post-creation-landing.spec.ts";

const TITLE =
  "creating a Spec lands the user directly on its doc view with the agent panel open and the 3-step handoff card (ac-3, ac-5)";

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    [AC_LAND, AC_CARD],
    testInfo.status === "passed" ? "pass" : "fail",
    `${FILE}::${testInfo.title}`,
    testInfo.duration,
  );
});

test(TITLE, async ({ page, resources }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

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

  // Queue the agent's authoring turn: turn 1 creates the Spec (create_doc), turn 2
  // is the closing hand-off text. openOnCreate navigates the instant create_doc
  // commits, so the landing recap turn that ChatPanel fires next consumes whatever
  // is left / falls back to the fake's default — the handoff card's visibility is
  // driven by nav state, not by that turn, so its exact content is immaterial.
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
  await queueAnthropicResponse({
    textDeltas: ["Your Spec is ready."],
    content: [{ type: "text", text: "Your Spec is ready." }],
    stopReason: "end_turn",
  });

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

  // ── ac-5: the post-creation handoff card renders inside the agent panel ───────
  // The creation→landing hop is the only place it shows. A fresh tenant has no
  // observed MCP traffic, so the FULL three-step card renders (not the connected /
  // collapsed variants), naming its beats: connect, copy, paste.
  const landing = page.getByTestId("creation-landing");
  await expect(landing).toBeVisible({ timeout: 15_000 });
  const card = page.getByTestId("post-creation-handoff-card");
  await expect(card).toBeVisible();
  // Step 1's LABEL frames the handoff as "Connect the Memex MCP server", never
  // "install it" (dec-7) — the reused CLI command underneath still legitimately
  // uses `install`, so we assert the connect framing at the heading, not a blanket
  // "no install anywhere" (that would fail on the command text, and rightly so).
  await expect(card).toContainText("Connect the Memex MCP server");
  await expect(card.getByText("Copy this Spec's URL")).toBeVisible();

  // The one-click Spec-URL copy affordance (step 2 CodeBlock) writes THIS Spec's
  // canonical URL to the real clipboard — proving the copy path, not just markup.
  const copyStep = card.getByTestId("handoff-spec-url");
  await expect(copyStep).toBeVisible();
  await copyStep.getByRole("button", { name: "Copy" }).click();
  await expect(copyStep.getByRole("button", { name: "Copied!" })).toBeVisible();

  const clip = (await page.evaluate(() => navigator.clipboard.readText())).trim();
  expect(clip).toContain(`/${tenant.namespaceSlug}/${tenant.memexSlug}/specs/spec-1`);
});
