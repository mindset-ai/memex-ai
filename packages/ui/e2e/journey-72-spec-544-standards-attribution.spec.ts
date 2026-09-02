import { test, expect, tenantPath, emitAcEvents } from "./helpers/index.js";
import { seedOrgTenant, seedStandard, seedTags } from "./helpers/retained.js";

// Journey 72 — spec-544 (std-28): repo attribution is VISIBLE on the Standards
// surface, read-only, with a coding-agent handoff.
//
// WHY THIS NEEDS A BROWSER AND NOT ONLY THE UNIT TESTS. The unit tests mount
// StandardList with a mocked `fetchDocs`, so they prove the component renders a
// chip when handed a tag. They cannot prove the tag SURVIVES the round trip: the
// list route attaches tags only under an opt-in `include=tags`, and a caller that
// forgets it gets rows with no tags key at all — which the component then renders,
// correctly and uselessly, as "unattributed" for every Standard. Only a real
// request against a real database distinguishes "the UI can show attribution"
// from "the UI does show attribution". That gap is exactly the shape of the
// failure this Spec exists to close, one layer up.
//
//   ac-18 — a Standard attributed to memex-clients shows that chip, on the list
//           card and on the detail page, without leaving the web app.
//   ac-19 — the attribution is read-only: no chip offers a remove affordance and
//           no tag input exists (std-34 cl-5).
//   ac-20 — the detail page carries a handoff whose link text names the ACTION
//           (std-34 cl-4).
//   ac-21 — an unattributed Standard renders a distinct marker, never zero chips.

const SPEC = "mindset-prod/memex-building-itself/specs/spec-544";
const AC_18 = `${SPEC}/acs/ac-18`;
const AC_19 = `${SPEC}/acs/ac-19`;
const AC_20 = `${SPEC}/acs/ac-20`;
const AC_21 = `${SPEC}/acs/ac-21`;

const ACS_BY_TEST: Record<string, string[]> = {};

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  const acRefs = ACS_BY_TEST[testInfo.title] ?? [];
  if (acRefs.length === 0) return;
  await emitAcEvents(
    acRefs,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-72-spec-544-standards-attribution.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

const TITLE =
  "attribution survives the round trip: a memex-clients Standard shows its chip, a both-repos Standard shows two, an untagged one reads unattributed, nothing is editable, and the detail page hands off (ac-18, ac-19, ac-20, ac-21)";
ACS_BY_TEST[TITLE] = [AC_18, AC_19, AC_20, AC_21];

test(TITLE, async ({ page, resources }) => {
  // Fresh org tenant owned by the auto-authed dev user, so the Standards list
  // starts empty and holds only what this journey seeds. Per-run unique slug
  // keeps parallel workers off each other's rows (std-37).
  const tenant = await seedOrgTenant({
    slug: resources.slug("spec544-attribution"),
    ownerEmail: "dev@memex.ai",
    memexSlug: "standards",
  });

  const desktopOnly = await seedStandard({
    memexId: tenant.memexId,
    title: "Flutter clients ship desktop-only",
  });
  const bothRepos = await seedStandard({
    memexId: tenant.memexId,
    title: "Module shape is a small interface over a lot of behaviour",
  });
  const unclassified = await seedStandard({
    memexId: tenant.memexId,
    title: "Nobody has classified this rule yet",
  });

  await seedTags({
    memexId: tenant.memexId,
    docId: desktopOnly.docId,
    tags: ["memex-clients"],
  });
  // Applied as TWO separate writes on purpose. dec-1 chose flat tags because a
  // scoped `repo::` value is mutually exclusive within its scope — the second
  // write would have dropped the first. If that ever regresses, this Standard
  // shows one chip instead of two and the assertion below names it.
  await seedTags({
    memexId: tenant.memexId,
    docId: bothRepos.docId,
    tags: ["memex-ai"],
  });
  await seedTags({
    memexId: tenant.memexId,
    docId: bothRepos.docId,
    tags: ["memex-clients"],
  });


  // ── The list ────────────────────────────────────────────────────────────
  await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, "/standards"));

  // The map is the default view (spec-179); the cards live in list mode.
  await page.getByTestId("standards-view-list").click();
  await expect(page.getByTestId("standard-card").first()).toBeVisible({
    timeout: 15_000,
  });

  const desktopCard = page
    .getByTestId("standard-card")
    .filter({ hasText: "Flutter clients ship desktop-only" });
  await expect(
    desktopCard.getByTestId("tag-chip").filter({ hasText: "memex-clients" }),
    "a memex-clients Standard must SAY so on its card — the attribution decides " +
      "which repo's index lists it, so it cannot be invisible here",
  ).toBeVisible();

  // The set case a scoped tag could not express.
  const bothCard = page
    .getByTestId("standard-card")
    .filter({ hasText: "Module shape is a small interface" });
  await expect(bothCard.getByTestId("tag-chip")).toHaveCount(2);
  await expect(bothCard.getByTestId("tag-chip").filter({ hasText: "memex-ai" })).toBeVisible();
  await expect(
    bothCard.getByTestId("tag-chip").filter({ hasText: "memex-clients" }),
  ).toBeVisible();

  // ac-21: absence is its own visible state, not a blank.
  const unclassifiedCard = page
    .getByTestId("standard-card")
    .filter({ hasText: "Nobody has classified this rule yet" });
  await expect(unclassifiedCard.getByTestId("tag-chip")).toHaveCount(0);
  await expect(
    unclassifiedCard.getByTestId("standard-unattributed"),
    "zero chips would be indistinguishable from a deliberate both-repos tagging",
  ).toBeVisible();
  // And an attributed Standard must not ALSO read as unclassified.
  await expect(desktopCard.getByTestId("standard-unattributed")).toHaveCount(0);

  // ac-19: read-only. No chip carries a remove control, anywhere on the page.
  await expect(page.locator('[data-testid="tag-chip"] button')).toHaveCount(0);
  await expect(page.getByTestId("tag-picker")).toHaveCount(0);

  // ── The detail page ─────────────────────────────────────────────────────
  await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/standards/${desktopOnly.handle}`));

  await expect(page.getByRole("heading", { name: /Flutter clients ship desktop-only/ })).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByTestId("tag-chip").filter({ hasText: "memex-clients" }),
    "the detail page is where someone reads one rule closely — attribution belongs there too",
  ).toBeVisible();
  await expect(page.locator('[data-testid="tag-chip"] button')).toHaveCount(0);

  // ac-20: the handoff, with the ACTION as the highlighted link text (cl-4).
  const handoff = page.getByTestId("standard-attribution-handoff");
  await expect(handoff).toBeVisible();
  await expect(
    handoff.getByText(/Attribute this Standard to a repo/),
    "cl-4: the link text names what the prompt DOES, not the tool it calls",
  ).toBeVisible();

  // cl-1: no MCP vocabulary in the copy a person reads. An instruction a human
  // cannot follow is the trust drain cl-8 records.
  const visible = (await page.locator("main").innerText()).toLowerCase();
  for (const leak of ["update_doc", "get_information", "search_memex", "removetags"]) {
    expect(visible, `on-screen copy must not contain "${leak}"`).not.toContain(leak);
  }

  // The unattributed marker reaches the detail page too.
  await page.goto(tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/standards/${unclassified.handle}`));
  await expect(page.getByTestId("standard-unattributed")).toBeVisible({ timeout: 15_000 });
});
