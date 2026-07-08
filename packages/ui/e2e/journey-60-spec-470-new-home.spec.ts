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

// Journey 60 — spec-470: the new build-first /home. A CONFIRMED spec-less user
// auto-lands on the Lovable-style "What do you want to build?" hero (dec-9), types a
// sentence, and the create-spec dialog AUTO-SENDS it to the agent (dec-4) — no extra
// click — which drafts a real Spec; the user lands on it. Once they have a spec they
// graduate: /home shows the onboarding tracker again and / lands on the Specs board.
//
// The Anthropic SDK is the only faked seam (MEMEX_ANTHROPIC_FAKE=1) — create_doc runs
// for real against the dev user's personal memex, so the drafted Spec is genuine
// server state. The hero opens the modal from the FLAT /home route, so this journey
// also proves the flat-route navigation fix (specsBasePath): "Open Spec" lands on the
// tenant-prefixed /<ns>/<mx>/specs/<handle>, not an unroutable /specs/<handle>.
//
// The `home`-feature-hidden rollback (ac-14/ac-6) is NOT covered here: HIDDEN_FEATURES
// is a server-boot env with no per-test hook (journey-49 notes the same), so it is
// proven in the App.spec-470 unit route-gate test instead.

const SPEC470 = "mindset-prod/memex-building-itself/specs/spec-470";
const AC1 = `${SPEC470}/acs/ac-1`; // spec-less sees the hero taking over /home
const AC2 = `${SPEC470}/acs/ac-2`; // type → dialog → agent drafts a real Spec → lands on it
const AC3 = `${SPEC470}/acs/ac-3`; // graduation + skip affordance
const AC4 = `${SPEC470}/acs/ac-4`; // spec-less reach /home; has-spec undisrupted
const AC5 = `${SPEC470}/acs/ac-5`; // activation funnel events emitted
const AC6 = `${SPEC470}/acs/ac-6`; // covered by a cold-DB e2e journey (std-28)

const FILE = "packages/ui/e2e/journey-60-spec-470-new-home.spec.ts";

// These tests use { page } (not the resources fixture), so the shared baseline reset —
// which clears the dev user's specs before each test — does NOT run. Test 1 creates a
// real Spec, so we must reset spec-less state ourselves or test 2 sees a graduated user
// (hasSpec=true → board, not the hero). Also suppress the spec-444 welcome-video gate.
test.beforeEach(async ({ page }) => {
  await ensureUser(DEV_EMAIL);
  await clearUserSpecs(DEV_EMAIL);
  await page.addInitScript(() => {
    sessionStorage.setItem("welcomeVideoDismissed", "1");
  });
});

test.afterEach(async ({}, testInfo) => {
  // Leave the shared dev user identity-confirmed for sibling journeys.
  await setIdentityConfirmed(DEV_EMAIL, true);
  if (testInfo.status === "skipped") return;
  const status = testInfo.status === "passed" ? "pass" : "fail";
  const acs = testInfo.title.includes("Skip to my specs")
    ? [AC3]
    : [AC1, AC2, AC3, AC4, AC5, AC6];
  await emitAcEvents(acs, status, `${FILE}::${testInfo.title}`, testInfo.duration);
});

test("a spec-less user builds their first spec from the hero and then graduates", async ({
  page,
}) => {
  await ensureUser(DEV_EMAIL);
  await setUserName(DEV_EMAIL, DEV_NAME);
  // Identity confirmed but NO spec yet — the fixture baseline clears specs before each
  // test, so hasSpec is false (confirmed spec-less).
  await setIdentityConfirmed(DEV_EMAIL, true);

  // ac-5: collect the activation-funnel telemetry the hero emits.
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

  // Queue the fake agent: one create_doc turn (a light Spec) + a closing text turn.
  // create_doc has no ref → it creates a NEW doc in the request's memex (the dev
  // user's personal memex, resolved from the session on the flat /home route).
  await clearAnthropicQueue();
  await queueAnthropicResponse({
    textDeltas: [],
    content: [
      {
        type: "tool_use",
        id: "c470_create",
        name: "create_doc",
        input: {
          title: "Weekly digest emailer",
          purpose: "Email me a Monday digest of my open specs.",
          docType: "spec",
        },
      },
    ],
    stopReason: "tool_use",
  });
  await queueAnthropicResponse({
    textDeltas: ["Your Spec is ready — open it to keep refining."],
    content: [
      { type: "text", text: "Your Spec is ready — open it to keep refining." },
    ],
    stopReason: "end_turn",
  });

  // ac-1 / ac-4: a spec-less user auto-lands on /home and sees the hero, not the tracker.
  await page.goto(bareUrl("/"));
  await expect(page).toHaveURL(/\/home(\?|#|$)/, { timeout: 15_000 });
  await expect(page.getByTestId("build-prompt-hero")).toBeVisible({ timeout: 15_000 });
  await expect(
    page.getByRole("heading", { name: "What do you want to build?" }),
  ).toBeVisible();
  await expect(page.getByTestId("getting-started-title")).toHaveCount(0);

  // ac-2: type a sentence + submit → the modal auto-sends it (no extra click), the
  // agent drafts a real Spec (create_doc runs for real), and the user lands straight
  // ON the new Spec — openOnCreate navigates the instant it's created (no "Open Spec"
  // click). This also proves the flat-route handoff resolves the tenant
  // (/<ns>/<mx>/specs/<handle>), not an unroutable /specs/<handle>.
  const heroInput = page.getByTestId("hero-input");
  await heroInput.fill("A tool that emails me a weekly digest of my open specs");
  await heroInput.press("Enter");

  await expect(page).toHaveURL(/\/specs\/spec-\d+$/, { timeout: 20_000 });

  // ac-5: the activation funnel fired — shown on hero render, submitted on submit.
  expect(telemetry).toContain("home.build_prompt_shown");
  expect(telemetry).toContain("home.build_prompt_submitted");

  // ac-3 / ac-4: graduation — now that the user has a spec, /home shows the tracker
  // (not the hero). Assert the tracker first (it waits for the fresh journey-state
  // read), then that the hero is gone.
  await page.goto(bareUrl("/home"));
  await expect(page.getByTestId("getting-started-title")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("build-prompt-hero")).toHaveCount(0);

  // ac-4: and / lands on the Specs board again (has-spec ⇒ board).
  await page.goto(bareUrl("/"));
  await expect(page).toHaveURL(/\/specs(\?|#|$)/, { timeout: 15_000 });
  await expect(page).not.toHaveURL(/\/home(\?|#|$)/);
});

test("the hero's 'Skip to my specs' link reaches the Specs board", async ({ page }) => {
  await ensureUser(DEV_EMAIL);
  await setUserName(DEV_EMAIL, DEV_NAME);
  await setIdentityConfirmed(DEV_EMAIL, true);

  await page.goto(bareUrl("/"));
  await expect(page.getByTestId("build-prompt-hero")).toBeVisible({ timeout: 15_000 });

  // ac-3: a spec-less user is never trapped — the skip link reaches their board.
  await page.getByTestId("hero-skip").click();
  await expect(page).toHaveURL(/\/specs(\?|#|$)/, { timeout: 15_000 });
});
