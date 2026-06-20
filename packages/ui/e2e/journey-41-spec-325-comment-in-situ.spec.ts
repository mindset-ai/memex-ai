import { test, expect, tenantPath, emitAcEvents } from "./helpers/index.js";
import { seedOrgTenant, seedSpec, seedComment } from "./helpers/retained.js";

// Journey 41 — spec-325: a comment link opens the comment IN SITU, in its
// section's spec-319 gutter, never on the flat Comments tab.
//
//   ac-1 : clicking a comment link opens it in situ — scrolled to + surfaced in
//          its section — and never lands on the flat Comments tab.
//   ac-3 : the content the comment refers to (its section body / anchored passage)
//          is visible alongside it; never stranded next to a bare heading.
//   ac-9 : the flat Comments tab (AllComments) is not the deep-link's destination.
//
// Real-browser tier (std-28): the deep-link → scroll → programmatic-pin path is a
// real load-time + layout effect jsdom can't reproduce; SectionCard.spec-325 /
// DocDocument.spec-325 pin the unit behaviour, this proves the whole flow in the
// browser and is the emitting tier for ac-1/ac-3/ac-9.
const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-325/acs/ac-${n}`;

const PASSAGE =
  "Provisioning the agent emission key is the first move; everything downstream depends on it.";
const SPAN_COMMENT = "This anchored note hangs off the first word.";
const SECTION_COMMENT = "A whole-section comment, no span anchor at all.";

test.afterEach(async ({}, testInfo) => {
  await emitAcEvents(
    [AC(1), AC(3), AC(9)],
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-41-spec-325-comment-in-situ.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

// Seed one spec carrying BOTH a span-anchored comment and a section-level comment
// on the same section, and return both seqs so each deep-link can be exercised.
async function seedSpecWithComments(resources) {
  const tenant = await seedOrgTenant({ slug: resources.slug("j41") });
  const spec = await seedSpec({
    memexId: tenant.memexId,
    title: "In-Situ Comment Spec",
    purpose: PASSAGE,
  });
  // Span comment: anchored to "Provisioning" (offsets 0..12) → renders its gutter
  // indicator at the anchored line, with the amber passage highlight.
  const span = await seedComment({
    memexId: tenant.memexId,
    target: "section",
    targetId: spec.sectionId,
    authorName: "Casey Reviewer",
    content: SPAN_COMMENT,
    anchorStartOffset: 0,
    anchorEndOffset: 12,
  });
  // Section-level comment: NO anchor offsets. Before spec-325 this rendered no
  // gutter indicator at all (it only showed on the flat tab); now it sits at the
  // top of the section body.
  const section = await seedComment({
    memexId: tenant.memexId,
    target: "section",
    targetId: spec.sectionId,
    authorName: "Dana Lead",
    content: SECTION_COMMENT,
  });
  return { tenant, spec, spanSeq: span.seq, sectionSeq: section.seq };
}

async function gotoComment(page, tenant, spec, seq: number) {
  await page.goto(
    tenantPath(
      tenant.namespaceSlug,
      tenant.memexSlug,
      `/specs/${spec.handle}?comment=c-${seq}`,
    ),
    { waitUntil: "commit" },
  );
  await expect(
    page.getByRole("heading", { level: 1, name: /In-Situ Comment Spec/ }),
  ).toBeVisible({ timeout: 15_000 });
}

test("a span-comment link opens the comment pinned in its section, not the flat tab (ac-1, ac-3, ac-9)", async ({
  page,
  resources,
}) => {
  const { tenant, spec, spanSeq } = await seedSpecWithComments(resources);
  await gotoComment(page, tenant, spec, spanSeq);

  // The comment is pinned IN SITU on load (the deep-link emulates a card click) —
  // its content is visible beside the section body, not on a divorced tab.
  const popover = page.getByTestId("comment-popover");
  await expect(popover).toBeVisible({ timeout: 15_000 });
  await expect(popover).toHaveAttribute("data-pinned", "true");
  await expect(popover).toContainText(SPAN_COMMENT);

  // The section it lives on is rendered (the content "this" refers to is visible).
  await expect(page.getByTestId("section-card").first()).toBeVisible();

  // It did NOT land on the flat AllComments tab — that view's summary is absent.
  await expect(page.getByTestId("open-comments-summary")).toHaveCount(0);
});

test("a section-level comment link opens it pinned at the section top, not the flat tab (ac-1, ac-3, ac-9)", async ({
  page,
  resources,
}) => {
  const { tenant, spec, sectionSeq } = await seedSpecWithComments(resources);
  await gotoComment(page, tenant, spec, sectionSeq);

  // A section-level comment (no span anchor) now renders in the gutter and is
  // pinned in situ by the deep-link — the spec-325 case that previously only
  // existed on the flat tab.
  const popover = page.getByTestId("comment-popover");
  await expect(popover).toBeVisible({ timeout: 15_000 });
  await expect(popover).toHaveAttribute("data-pinned", "true");
  await expect(popover).toContainText(SECTION_COMMENT);

  // Its gutter indicator exists (proof it renders in-context at all).
  await expect(page.locator(`#indicator-c-${sectionSeq}`)).toBeVisible();

  // Still never the flat Comments tab.
  await expect(page.getByTestId("open-comments-summary")).toHaveCount(0);
});
