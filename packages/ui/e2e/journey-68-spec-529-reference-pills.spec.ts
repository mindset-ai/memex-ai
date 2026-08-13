import { test, expect, tenantPath } from "./helpers/index.js";
import { seedOrgTenant, seedSpec, seedSection, setDocStatus } from "./helpers/retained.js";
import { installAcEmission } from "./helpers/emit-ac.js";

// spec-529 t-7 — the PR-gate journey (std-28) for reference pills.
//
// The shape that matters is the LAST step. A journey that stopped at "a pill
// appeared" would pass just as happily over a hardcoded string, and the entire
// value of this Spec is that the number is LIVE rather than copied — it exists
// because a hand-maintained status table beside a reference goes stale within the
// hour and no reader can tell. So the journey changes the referenced Spec's phase
// through the real service and comes back to watch the pill follow.
//
// It also pins the two states that must NOT become pills: a handle naming nothing,
// and a handle inside a code span.

const SPEC = "mindset-prod/memex-building-itself/specs/spec-529";
const AC_PILL = `${SPEC}/acs/ac-1`;
const AC_CARD = `${SPEC}/acs/ac-2`;
const AC_UNRESOLVED = `${SPEC}/acs/ac-3`;

const T1 =
  "a bare spec handle in a document body renders as a pill carrying live phase, opens a card, and follows the referenced Spec when it moves";
const T2 = "a handle that names nothing, and one inside a code span, stay plain text";

installAcEmission(test, import.meta.url, {
  [T1]: [AC_PILL, AC_CARD],
  [T2]: [AC_UNRESOLVED],
});

test(T1, async ({ page, resources }) => {
  const slug = resources.slug("j68a");
  const tenant = await seedOrgTenant({ slug });

  // The Spec that gets REFERENCED.
  const referenced = await seedSpec({
    memexId: tenant.memexId,
    title: "The board becomes reliable and legible again",
    purpose: "The Spec another document points at.",
  });

  // The document that POINTS at it, writing the handle bare in its prose exactly as
  // an author (or a coding agent) does unprompted.
  const host = await seedSpec({
    memexId: tenant.memexId,
    title: "Where the observability work stands",
    purpose: "A document that refers to other Specs.",
  });
  await seedSection({
    memexId: tenant.memexId,
    docId: host.docId,
    title: "Specs that exist",
    content: `The board work lands in ${referenced.handle} this week.`,
  });

  const hostUrl = tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/specs/${host.handle}`);
  await page.goto(hostUrl);

  // ── 1) The bare handle became a pill, carrying the referenced Spec's phase. ──
  const pill = page.getByTestId("spec-ref-pill").filter({ hasText: referenced.handle });
  await expect(pill).toBeVisible({ timeout: 15_000 });
  await expect(pill).toContainText("draft");

  // ── 2) The card tells the whole story, and the title is on IT, not the pill. ──
  await expect(pill).not.toContainText("The board becomes reliable");
  await pill.focus();
  const card = page.getByTestId("spec-ref-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("The board becomes reliable and legible again");
  // A Spec with no commitments reads as having none — never as 0% complete.
  await expect(card.getByTestId("spec-ref-acs")).toContainText("No acceptance criteria yet");

  // ── 3) The pill is a link into the referenced Spec. ─────────────────────────
  await expect(pill).toHaveAttribute(
    "href",
    new URL(
      tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/specs/${referenced.handle}`),
    ).pathname,
  );

  // ── 4) THE POINT: move the referenced Spec, and the pill follows. ───────────
  // Through the real updateDocStatus service, so this is a genuine state change
  // rather than a fixture rewrite.
  await setDocStatus({
    memexId: tenant.memexId,
    docId: referenced.docId,
    status: "build",
  });

  await page.goto(hostUrl);
  const movedPill = page.getByTestId("spec-ref-pill").filter({ hasText: referenced.handle });
  await expect(movedPill).toBeVisible({ timeout: 15_000 });
  // The number on the page changed because the Spec changed — nothing was edited
  // in the document that mentions it.
  await expect(movedPill).toContainText("build");
  await expect(movedPill).not.toContainText("draft");
});

test(T2, async ({ page, resources }) => {
  const slug = resources.slug("j68b");
  const tenant = await seedOrgTenant({ slug });

  const host = await seedSpec({
    memexId: tenant.memexId,
    title: "A document with handles that must stay text",
    purpose: "Pins the two non-pill states.",
  });
  await seedSection({
    memexId: tenant.memexId,
    docId: host.docId,
    title: "Handles that are not references",
    // spec-99999 exists nowhere in this tenant; the second is inside a code span.
    content:
      "Nothing here is spec-99999, and the literal `spec-12345` is a code sample.",
  });

  await page.goto(
    tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/specs/${host.handle}`),
  );
  await expect(
    page.getByRole("heading", { name: /Handles that are not references/ }),
  ).toBeVisible({ timeout: 15_000 });

  // Neither handle became a pill: an unreadable Spec and a non-existent one must be
  // indistinguishable [per std-7], and a code sample renders verbatim.
  await expect(page.getByTestId("spec-ref-pill")).toHaveCount(0);
  // The seeded section, not the Spec's Overview — `.first()` is the Overview.
  const body = page
    .getByTestId("section-card")
    .filter({ hasText: "Handles that are not references" });
  await expect(body).toContainText("spec-99999");
  await expect(body.locator("code", { hasText: "spec-12345" })).toBeVisible();
});
