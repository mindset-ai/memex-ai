import {
  test,
  expect,
  bareUrl,
  emitAcEvents,
  ensureUser,
  setUserName,
  setIdentityConfirmed,
  clearUserSpecs,
  DEV_EMAIL,
  DEV_NAME,
} from "./helpers/index.js";
import {
  clearAnthropicQueue,
  queueAnthropicResponse,
} from "./helpers/anthropic-fake.js";

// Journey 60 — spec-473: the pivoted IMPORT /home. This file originally covered
// spec-470's "What do you want to build?" sentence-first hero; spec-473 deliberately
// REMOVED that idea-sentence path and replaced it with an import challenge, so the
// journey now drives the current reality (issue-2 reconcile): a CONFIRMED spec-less
// user lands on the import hero, hands over an existing document — by PASTE or by
// in-browser FILE read — and the create-spec dialog AUTO-SENDS it to the agent as a
// document seed (seedKind='document'). The agent drafts a real Spec and the user
// lands ON it. Once they have a spec they graduate: /home shows the onboarding
// tracker again and / lands on the Specs board.
//
// The Anthropic SDK is the only faked seam (MEMEX_ANTHROPIC_FAKE=1) — create_doc runs
// for real against the dev user's personal memex, so the drafted Spec is genuine
// server state (ac-3 lands-on-a-real-Spec). The document's structured population
// (sections / decisions / ACs as rows) is proven at the unit seam
// (NewSpecModal.spec-473 composes the "convert into a structured Spec" instruction)
// and the live-model eval — the fake can't reference the runtime-created doc ref, so
// here we assert the create → land-on-Spec spine end-to-end.
//
// The `home`-feature-hidden rollback is NOT covered here: HIDDEN_FEATURES is a
// server-boot env with no per-test hook, so it is proven in the App unit route-gate
// test instead.

const SPEC473 = "mindset-prod/memex-building-itself/specs/spec-473";
const AC1 = `${SPEC473}/acs/ac-1`; // spec-less sees the import hero taking over /home
const AC2 = `${SPEC473}/acs/ac-2`; // paste AND file both feed the same create-spec path
const AC3 = `${SPEC473}/acs/ac-3`; // agent drafts a real Spec → user lands ON it
const AC4 = `${SPEC473}/acs/ac-4`; // idea INPUT gone; graduation + escape preserved
const AC6 = `${SPEC473}/acs/ac-6`; // activation funnel measured end-to-end (cold-DB journey)

const FILE = "packages/ui/e2e/journey-60-spec-470-new-home.spec.ts";

const IMPORT_DOC =
  "# Realtime Presence PRD\n\n## Problem\nUsers cannot tell who else is viewing a doc.\n\n" +
  "## Goals\n- Live avatars in the header\n- Presence heartbeat every 20s\n\n## Out of scope\n- Cursors";

// Queue a two-turn fake agent run: create_doc (a real Spec in the request's memex) then
// a closing text turn. openOnCreate for seedKind='document' defers navigation until the
// stream ends, so the user lands on the Spec after the closing turn.
async function queueImportRun() {
  await clearAnthropicQueue();
  await queueAnthropicResponse({
    textDeltas: [],
    content: [
      {
        type: "tool_use",
        id: "c473_create",
        name: "create_doc",
        input: {
          title: "Realtime Presence",
          purpose: "Show who else is viewing a doc, with live avatars and a heartbeat.",
          docType: "spec",
        },
      },
    ],
    stopReason: "tool_use",
  });
  await queueAnthropicResponse({
    textDeltas: ["Your Spec is drafted — open it to keep refining."],
    content: [
      { type: "text", text: "Your Spec is drafted — open it to keep refining." },
    ],
    stopReason: "end_turn",
  });
}

// These tests use { page } (not the resources fixture), so the shared baseline reset —
// which clears the dev user's specs before each test — does NOT run. Tests that create a
// real Spec must reset spec-less state themselves or a sibling sees a graduated user
// (hasSpec=true → board, not the hero). Also suppress the welcome-video gate.
test.beforeEach(async ({ page }) => {
  await ensureUser(DEV_EMAIL);
  await setUserName(DEV_EMAIL, DEV_NAME);
  await clearUserSpecs(DEV_EMAIL);
  await setIdentityConfirmed(DEV_EMAIL, true);
  await page.addInitScript(() => {
    sessionStorage.setItem("welcomeVideoDismissed", "1");
  });
});

test.afterEach(async ({}, testInfo) => {
  await setIdentityConfirmed(DEV_EMAIL, true);
  if (testInfo.status === "skipped") return;
  const status = testInfo.status === "passed" ? "pass" : "fail";
  const title = testInfo.title;
  const acs = title.includes("Skip to my specs")
    ? [AC4]
    : title.includes("file upload")
      ? [AC2, AC3, AC6]
      : [AC1, AC2, AC3, AC4, AC6];
  await emitAcEvents(acs, status, `${FILE}::${title}`, testInfo.duration);
});

test("a spec-less user imports a pasted document into a real Spec, then graduates", async ({
  page,
}) => {
  // ac-6: collect the activation-funnel telemetry the import hero emits.
  const telemetry: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/telemetry")) {
      try {
        const body = req.postDataJSON() as { name?: string };
        if (body?.name) telemetry.push(body.name);
      } catch {
        /* non-JSON body — ignore */
      }
    }
  });

  await queueImportRun();

  // ac-1 / ac-4: a spec-less user auto-lands on /home and sees the IMPORT hero, not the
  // tracker, and not the retired spec-470 idea prompt.
  await page.goto(bareUrl("/"));
  await expect(page).toHaveURL(/\/home(\?|#|$)/, { timeout: 15_000 });
  await expect(page.getByTestId("build-prompt-hero")).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole("heading", { name: /Turn your MD doc into a living Memex Spec/i }),
  ).toBeVisible();
  await expect(page.getByText("What do you want to build?")).toHaveCount(0);
  await expect(page.getByTestId("getting-started-title")).toHaveCount(0);

  // ac-2 / ac-3: paste a document + submit → the modal auto-sends it as a document seed
  // (no extra click), the agent drafts a real Spec (create_doc runs for real), and the
  // user lands straight ON the new Spec once the stream ends (deferred openOnCreate).
  await page.getByTestId("hero-input").fill(IMPORT_DOC);
  await page.getByTestId("hero-submit").click();

  await expect(page).toHaveURL(/\/specs\/spec-\d+$/, { timeout: 25_000 });

  // ac-6: the activation funnel fired — shown on hero render, submitted on submit.
  expect(telemetry).toContain("home.import_shown");
  expect(telemetry).toContain("home.import_submitted");

  // ac-4: graduation — now that the user has a spec, /home shows the tracker (not the
  // hero). Assert the tracker first (it waits for the fresh journey-state read), then
  // that the hero is gone.
  await page.goto(bareUrl("/home"));
  await expect(page.getByTestId("getting-started-title")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("build-prompt-hero")).toHaveCount(0);

  // ac-4: and / lands on the Specs board again (has-spec ⇒ board).
  await page.goto(bareUrl("/"));
  await expect(page).toHaveURL(/\/specs(\?|#|$)/, { timeout: 15_000 });
  await expect(page).not.toHaveURL(/\/home(\?|#|$)/);
});

test("importing via file upload feeds the same create-spec path", async ({ page }) => {
  const telemetry: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().includes("/telemetry")) {
      try {
        const body = req.postDataJSON() as { name?: string };
        if (body?.name) telemetry.push(body.name);
      } catch {
        /* ignore */
      }
    }
  });

  await queueImportRun();

  await page.goto(bareUrl("/"));
  await expect(page.getByTestId("build-prompt-hero")).toBeVisible({ timeout: 15_000 });

  // ac-2: a dropped/selected .md file is read in-browser (FileReader) into the SAME seed
  // the paste path uses — its text fills the paste field, then submit runs the same flow.
  await page.getByTestId("hero-file-input").setInputFiles({
    name: "presence.md",
    mimeType: "text/markdown",
    buffer: Buffer.from(IMPORT_DOC, "utf-8"),
  });
  await expect(page.getByTestId("hero-input")).toHaveValue(IMPORT_DOC, { timeout: 10_000 });
  await expect(page.getByTestId("hero-filename")).toHaveText(/presence\.md/);

  // ac-3: submit → same create-spec path → land on the real Spec.
  await page.getByTestId("hero-submit").click();
  await expect(page).toHaveURL(/\/specs\/spec-\d+$/, { timeout: 25_000 });

  // ac-6: the funnel still fires on the file path.
  expect(telemetry).toContain("home.import_shown");
  expect(telemetry).toContain("home.import_submitted");
});

test("the import hero's 'Skip to my specs' link reaches the Specs board", async ({ page }) => {
  await page.goto(bareUrl("/"));
  await expect(page.getByTestId("build-prompt-hero")).toBeVisible({ timeout: 15_000 });

  // ac-4: a spec-less user is never trapped — the skip link reaches their board.
  await page.getByTestId("hero-skip").click();
  await expect(page).toHaveURL(/\/specs(\?|#|$)/, { timeout: 15_000 });
});
