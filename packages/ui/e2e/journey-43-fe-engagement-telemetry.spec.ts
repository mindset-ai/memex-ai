import { test, expect, gotoSpecsBoard } from "./helpers/index.js";
import {
  getPersonalMemexByEmail,
  ensureUser,
  setUserName,
  seedSpecInMemex,
  deleteDoc,
  emitAcEvents,
} from "./helpers/index.js";
import type { Page, Request } from "@playwright/test";

// std-28 PR-gate journey for the front-end engagement events seeded per std-35
// Recipe A (the spec-336 Home-revamp follow-on). Component tests cover each
// track() site under jsdom; this journey proves the rail end-to-end in a real
// browser — a click reaches the typed track() and lands a POST /api/<ns>/<mx>/
// telemetry with the registered name + IDs/enums/counts only (no content).
//
// Auth/tenant: drive the dev session like journey-18 — the dev fixture's personal
// memex (namespace `dev` / memex `personal`). Authenticated users are tracked by
// default (spec-326), so track() fires without a consent dance. Path-based nav.

const SPEC_TITLE = "Vorpal Narwhal Telemetry Beacon";

// Resolve the tenant /telemetry POST for a given registered event name, with an
// optional predicate over its sanitised props. Returns the parsed body.
function waitForTelemetry(
  page: Page,
  name: string,
  propsPredicate?: (props: Record<string, unknown>) => boolean,
): Promise<{ name: string; props: Record<string, unknown> }> {
  return page
    .waitForRequest(
      (req: Request) => {
        if (req.method() !== "POST" || !req.url().includes("/telemetry")) return false;
        try {
          const body = JSON.parse(req.postData() ?? "{}");
          if (body.name !== name) return false;
          return propsPredicate ? propsPredicate(body.props ?? {}) : true;
        } catch {
          return false;
        }
      },
      { timeout: 20_000 },
    )
    .then((req) => JSON.parse(req.postData()!));
}

test.describe("Journey 43 — front-end engagement telemetry (std-35)", () => {
  let docId: string;
  let nsSlug: string;
  let mxSlug: string;
  let specHandle: string;

  test.beforeEach(async () => {
    const memex = await getPersonalMemexByEmail("dev@memex.ai");
    if (!memex) throw new Error("dev@memex.ai has no personal memex — fixture setup drifted");
    nsSlug = memex.namespaceSlug;
    mxSlug = memex.memexSlug;
    await setUserName("dev@memex.ai", "Dev User");
    const devUserId = await ensureUser("dev@memex.ai");
    ({ docId, handle: specHandle } = await seedSpecInMemex({
      memexId: memex.memexId,
      title: SPEC_TITLE,
      purpose: "Vorpal Narwhal Telemetry Beacon — purpose body for the telemetry journey.",
      createdByUserId: devUserId,
    }));
  });

  test.afterEach(async () => {
    if (docId) await deleteDoc(docId);
  });

  // std-28 / std-35 step 6: emit pass/fail for the ACs this journey evidences,
  // keyed by test title (routing is namespace-derived → memex.ai). The search
  // funnel proves query_submitted (ac-12); the card test proves card_opened
  // (ac-10); all three prove the FE events fire (ac-1), carry no content (ac-2),
  // and that the std-28 journey exists (ac-6).
  const SPEC = "mindset-prod/memex-building-itself/specs/spec-338";
  const ACS_BY_TEST: Record<string, string[]> = {
    "the ⌘K search funnel emits opened → query_submitted → result_selected": [
      `${SPEC}/acs/ac-12`,
      `${SPEC}/acs/ac-1`,
      `${SPEC}/acs/ac-2`,
      `${SPEC}/acs/ac-6`,
    ],
    "opening a spec card on the board emits spec.card_opened (the 'spec#' + phase)": [
      `${SPEC}/acs/ac-10`,
      `${SPEC}/acs/ac-1`,
      `${SPEC}/acs/ac-2`,
      `${SPEC}/acs/ac-6`,
    ],
    "the board search trigger button emits search.opened with trigger=button": [
      `${SPEC}/acs/ac-1`,
      `${SPEC}/acs/ac-6`,
    ],
  };
  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status === "skipped") return;
    const refs = ACS_BY_TEST[testInfo.title];
    if (!refs) return;
    await emitAcEvents(
      refs,
      testInfo.status === "passed" ? "pass" : "fail",
      `packages/ui/e2e/journey-43-fe-engagement-telemetry.spec.ts::${testInfo.title}`,
      testInfo.duration ?? 0,
    );
  });

  const HOTKEY = process.platform === "darwin" ? "Meta+k" : "Control+k";

  test("the ⌘K search funnel emits opened → query_submitted → result_selected", async ({
    page,
  }) => {
    await gotoSpecsBoard(page);
    await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible({ timeout: 15_000 });

    // search.opened (hotkey): arm before the keypress.
    const opened = waitForTelemetry(
      page,
      "search.opened",
      (p) => p.trigger === "hotkey",
    );
    await page.keyboard.press(HOTKEY);
    const dialog = page.getByRole("dialog", { name: "Search this memex" });
    await expect(dialog).toBeVisible();
    expect((await opened).props.trigger).toBe("hotkey");

    // search.query_submitted: fires after the debounced fetch settles. Props are
    // counts/bools only — the query text must NEVER appear.
    const submitted = waitForTelemetry(page, "search.query_submitted");
    await page.getByPlaceholder(/Search specs/i).fill(SPEC_TITLE);
    const submittedBody = await submitted;
    expect(typeof submittedBody.props.queryLength).toBe("number");
    expect(submittedBody.props.hasResults).toBe(true);
    // Defence-in-depth: no prop value carries the query string.
    expect(JSON.stringify(submittedBody.props)).not.toContain(SPEC_TITLE);

    // search.result_selected: arm, then click the seeded Spec's row.
    const selected = waitForTelemetry(page, "search.result_selected");
    const specRow = dialog
      .locator('[data-testid="search-result"][data-kind="spec"]')
      .filter({ hasText: SPEC_TITLE })
      .first();
    await expect(specRow).toBeVisible({ timeout: 10_000 });
    await specRow.click();
    const selectedBody = await selected;
    expect(["jumpTo", "assigned", "content"]).toContain(selectedBody.props.lane);
    expect(selectedBody.props.resultKind).toBe("spec");
    expect(typeof selectedBody.props.resultIndex).toBe("number");

    // The selection actually navigated to the Spec (the track() didn't block it).
    await expect(page).toHaveURL(new RegExp(`/specs/${specHandle}(\\b|/|$)`), {
      timeout: 10_000,
    });
  });

  test("opening a spec card on the board emits spec.card_opened (the 'spec#' + phase)", async ({
    page,
  }) => {
    await gotoSpecsBoard(page);
    await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible({ timeout: 15_000 });

    const cardOpened = waitForTelemetry(page, "spec.card_opened");
    // The board card is a link to /specs/<handle>; click the seeded one.
    await page.getByRole("link", { name: new RegExp(SPEC_TITLE, "i") }).first().click();

    const body = await cardOpened;
    // specSeq is the spec's handle ordinal (the "spec#") — an id, never a title.
    expect(body.props.specSeq).toBeDefined();
    expect(["draft", "specify", "build", "verify", "done"]).toContain(body.props.phase);
    expect(typeof body.props.assigned).toBe("boolean");
    expect(JSON.stringify(body.props)).not.toContain(SPEC_TITLE);
  });

  test("the board search trigger button emits search.opened with trigger=button", async ({
    page,
  }) => {
    await gotoSpecsBoard(page);
    await expect(page.getByRole("heading", { name: "Specs" })).toBeVisible({ timeout: 15_000 });

    const opened = waitForTelemetry(page, "search.opened", (p) => p.trigger === "button");
    await page.getByTestId("search-palette-trigger-board").click();
    expect((await opened).props.trigger).toBe("button");
  });
});
