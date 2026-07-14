import { test, expect, tenantPath, emitAcEvents } from "./helpers/index.js";
import { seedOrgTenant } from "./helpers/retained.js";
import {
  clearAnthropicQueue,
  queueAnthropicResponse,
} from "./helpers/anthropic-fake.js";

// Journey 61 (spec-482): the post-creation landing + agent handoff (std-28 gate).
//
// After a user creates a Spec through the in-app creation flow they land DIRECTLY
// on the newly-created Spec's document view — not the Kanban board, not a closed
// dialogue — with the agent panel (ChatPanel) open. The agent then delivers the
// MCP handoff conversationally: there is NO persistent handoff card (dec-7 revised,
// t-12 — it duplicated the agent's own recap and was ditched); instead the agent
// emits the copyable connect/paste text through a `render_handoff` block with a
// Copy button (the shared cross-agent handoff affordance, std-34/std-38).
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
//   • ChatPanel reads that nav state (isCreationLanding) and fires the landing
//     opening turn — a real /llm/chat call. Under the fake Anthropic seam we script
//     that turn to emit a `render_handoff` block, so its Copy-button affordance
//     (testid `agent-handoff` / `handoff-copy`) renders inside the messages area.
//
// The Anthropic SDK is the ONLY faked seam (MEMEX_ANTHROPIC_FAKE=1): create_doc runs
// for real against a freshly seeded, isolated memex, so the first Spec is
// deterministically `spec-1` (nextSpecHandle is per-memex).
//
// Emits spec-482 ac-3 (land directly on the created Spec's doc view with the agent
// panel present) and ac-5 (the handoff delivered as a render_handoff Copy affordance,
// carrying the paste-into-your-coding-agent prompt — never inline, never a card).

const SPEC482 = "mindset-prod/memex-building-itself/specs/spec-482";
const AC_LAND = `${SPEC482}/acs/ac-3`; // land on the Spec doc view, agent panel open
const AC_CARD = `${SPEC482}/acs/ac-5`; // the agent handoff (render_handoff Copy affordance)

const FILE = "packages/ui/e2e/journey-61-spec-482-post-creation-landing.spec.ts";

const TITLE =
  "creating a Spec lands the user directly on its doc view with the agent panel open and the agent's render_handoff Copy affordance (ac-3, ac-5)";

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

  // The Spec URL the agent hands off — the exact path its render_handoff prompt must
  // carry so the user can paste it into their coding agent.
  const specPath = tenantPath(
    tenant.namespaceSlug,
    tenant.memexSlug,
    "/specs/spec-1",
  );
  const handoffPrompt =
    `Use the Memex MCP on this Spec: ${specPath} — read it, then take it forward.`;

  // Queue the agent turns in order. The create flow consumes exactly ONE response
  // (the create_doc tool call): openOnCreate navigates onto the new Spec the instant
  // create_doc commits, aborting any create-side follow-up. The very next model call
  // is the landing opening turn ChatPanel fires (startCreationLandingTurn) — so the
  // SECOND queued response is what the landing renders. We script it as a
  // render_handoff, so its Copy-button affordance shows (post-t-12 the handoff is
  // agent-delivered, not a card).
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
    textDeltas: [],
    content: [
      {
        type: "tool_use",
        id: "c482_handoff",
        name: "render_handoff",
        input: {
          target: "your coding agent",
          reason:
            "Connect your coding agent over MCP, then paste this to take the Spec forward.",
          prompt: handoffPrompt,
        },
      },
    ],
    stopReason: "tool_use",
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

  // ── ac-5: the agent delivers the handoff as a render_handoff Copy affordance ───
  // No persistent card (dec-7 revised). On the creation→landing hop the landing turn
  // emits render_handoff, which renders as the shared handoff block (testid
  // `agent-handoff`) carrying the ready-to-paste "use the Memex MCP on this Spec"
  // prompt — with a Copy button, never inline copyable text.
  const handoff = page.getByTestId("agent-handoff");
  await expect(handoff).toBeVisible({ timeout: 15_000 });
  await expect(handoff).toContainText(/use the Memex MCP on this Spec/i);

  // The Copy button writes the ready-to-paste prompt — carrying THIS Spec's canonical
  // path — to the real clipboard, proving the copy path (not just markup).
  await handoff.getByTestId("handoff-copy").click();
  await expect(handoff.getByRole("button", { name: "Copied" })).toBeVisible();

  const clip = (await page.evaluate(() => navigator.clipboard.readText())).trim();
  expect(clip).toContain(`/${tenant.namespaceSlug}/${tenant.memexSlug}/specs/spec-1`);
});
