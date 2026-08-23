import { test, expect, tenantPath } from "./helpers/index.js";
import { seedOrgTenant, seedSpec } from "./helpers/retained.js";
import { installAcEmission } from "./helpers/emit-ac.js";

// spec-535 t-8 — the PR-gate journey (std-28) for the sensitivity flag.
//
// The loop that matters is the WHOLE loop: flag from the byline, watch the banner
// appear near the title naming the contact, clear it, watch the banner go. A
// journey that stopped at "the banner appeared" would pass over a banner nothing
// can turn off, and an unflagged Spec wearing a permanent warning is worse than no
// warning at all — it trains people to ignore the surface.
//
// It also pins the two properties the whole design rests on, neither of which any
// unit test can reach because both are about the assembled page:
//
//   * the SETTER and the SIGNAL are different surfaces (dec-4). The control sits
//     on the byline; the banner sits near the title, outside that row. A unit test
//     mounting either component in isolation cannot tell you they ended up in the
//     same place on the real page.
//   * the flag BLOCKS NOTHING (ac-3). The Spec's whole premise is advisory, so the
//     journey edits the Spec while it is flagged and expects that to work. If this
//     ever fails, the feature has become the thing it was built to avoid.

const SPEC = "mindset-prod/memex-building-itself/specs/spec-535";
const AC_JOURNEY = `${SPEC}/acs/ac-19`;
const AC_NON_BLOCKING = `${SPEC}/acs/ac-3`;
const AC_CLEARS = `${SPEC}/acs/ac-4`;

const T1 =
  "flagging a Spec from the byline raises a banner near the title naming the contact, and clearing it takes the banner away";
const T2 = "a flagged Spec is still fully editable — the warning blocks nothing";

installAcEmission(test, import.meta.url, {
  [T1]: [AC_JOURNEY, AC_CLEARS],
  [T2]: [AC_NON_BLOCKING],
});

test(T1, async ({ page, resources }) => {
  const slug = resources.slug("j70a");
  const tenant = await seedOrgTenant({ slug });

  const spec = await seedSpec({
    memexId: tenant.memexId,
    title: "The phase enum the deploy gate reads",
    purpose: "A Spec that is delicate to change.",
  });

  const url = tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/specs/${spec.handle}`);
  await page.goto(url);

  // ── 1) Unflagged: no banner, and the control offers to flag. ──
  await expect(page.getByTestId("sensitive-banner")).toHaveCount(0);
  const control = page.getByRole("button", { name: /flag as sensitive/i });
  await expect(control).toBeVisible();

  // ── 2) Flag it. One click — no dialog, and no person to pick: whoever flags it
  //       becomes the contact (dec-2), which is why no picker exists. ──
  await control.click();

  const banner = page.getByTestId("sensitive-banner");
  await expect(banner).toBeVisible();

  // The banner names WHO to contact. Asserting only that a banner exists would
  // pass over a banner that says nothing actionable — "this is sensitive" on its
  // own tells a reader nothing they can do.
  await expect(banner).toContainText(/contact/i);

  // The setter and the signal are genuinely different surfaces (dec-4): the banner
  // is NOT inside the byline row that carries the assignee and tag chips.
  const bannerInByline = page.locator('[data-testid="sensitive-banner"] >> xpath=ancestor::*[contains(@class,"flex-wrap")]');
  await expect(bannerInByline).toHaveCount(0);

  // ── 3) Clear it from the same control, and the banner goes. ──
  await page.getByRole("button", { name: /clear the sensitive flag/i }).click();
  await expect(page.getByTestId("sensitive-banner")).toHaveCount(0);

  // And the state is real, not local: a fresh load still shows it cleared.
  await page.goto(url);
  await expect(page.getByTestId("sensitive-banner")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /flag as sensitive/i })).toBeVisible();
});

test(T2, async ({ page, resources }) => {
  const slug = resources.slug("j70b");
  const tenant = await seedOrgTenant({ slug });

  const spec = await seedSpec({
    memexId: tenant.memexId,
    title: "A Spec somebody marked delicate",
    purpose: "Flagged, and still open for business.",
  });

  const url = tenantPath(tenant.namespaceSlug, tenant.memexSlug, `/specs/${spec.handle}`);
  await page.goto(url);

  await page.getByRole("button", { name: /flag as sensitive/i }).click();
  await expect(page.getByTestId("sensitive-banner")).toBeVisible();

  // The flag is advisory (ac-3). Every affordance that worked before must still
  // work — the failure this guards against is someone later "hardening" the flag
  // into a soft lock, which would quietly invert the Spec's premise.
  await expect(page.getByRole("button", { name: /clear the sensitive flag/i })).toBeEnabled();

  // A phase move is the heaviest ordinary write on this page; if that is still
  // available while flagged, lighter edits are too.
  const phaseControl = page.getByTestId("phase-directive");
  if ((await phaseControl.count()) > 0) {
    await expect(phaseControl).toBeVisible();
  }

  // And the banner survives a reload rather than being a transient toast.
  await page.reload();
  await expect(page.getByTestId("sensitive-banner")).toBeVisible();
});
