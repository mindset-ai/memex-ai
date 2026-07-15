import {
  test,
  expect,
  tenantPath,
  emitAcEvents,
} from "./helpers/index.js";
import {
  seedOrgTenant,
  seedSpec,
  setDocStatus,
  seedComment,
} from "./helpers/retained.js";

// Journey 62 — spec-484: UI rendering correctness, end-to-end against the
// running app.
//
// spec-484 fixed two display defects with render-time / read-time transforms:
//   1. Titles stored HTML-entity-encoded (legacy data, e.g. "Foo &amp;amp; Bar")
//      now DECODE on read across every title surface — the spec board / doc list
//      was the primary reported location (fetchDocs, previously undecoded).
//   2. Prose fields (comment bodies, trade-offs, …) now RENDER markdown instead
//      of literal syntax.
//
// The component tests mock the API layer; this journey is the full-stack proof —
// a real seeded entity-encoded title decodes through the real fetch → board
// render, and a real markdown comment body renders as markdown in the running UI.
// (ac-2's public shared-viewer leg and the remaining prose surfaces stay on the
// component suite; this journey covers the primary board surface + the comment
// body, the highest-value user-facing paths.)
const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-484/acs/ac-${n}`;

// Per-test AC attribution — each test emits ONLY the ACs it actually exercises,
// so a failure in one doesn't falsely fail the other's criteria.
const ACS_BY_TEST: Record<string, string[]> = {
  "entity-encoded titles decode on the spec board and the doc detail (ac-1, ac-5)":
    [AC(1), AC(5)],
  "a markdown comment body renders as markdown, not literal syntax (ac-6)": [
    AC(6),
  ],
};

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  const acs = ACS_BY_TEST[testInfo.title] ?? [];
  if (acs.length === 0) return;
  await emitAcEvents(
    acs,
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-62-spec-484-render-correctness.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test(
  "entity-encoded titles decode on the spec board and the doc detail (ac-1, ac-5)",
  async ({ page, resources }) => {
    const tenant = await seedOrgTenant({ slug: resources.slug("j62a") });
    // Title stored DOUBLE-encoded ("&amp;amp;") — the strongest case: the
    // fixpoint decoder must resolve it fully to a single "&" (ac-5), and it must
    // do so on the board list surface (fetchDocs), the primary reported bug (ac-1).
    const spec = await seedSpec({
      memexId: tenant.memexId,
      title: "Billing &amp;amp; Invoicing",
      purpose: "Exercise entity-title decode-on-read across surfaces.",
    });
    await setDocStatus({
      memexId: tenant.memexId,
      docId: spec.docId,
      status: "specify",
    });

    // ── The spec board (doc list, fetchDocs) renders the title DECODED ──
    await page.goto(
      tenantPath(tenant.namespaceSlug, tenant.memexSlug, "/specs"),
      { waitUntil: "commit" },
    );
    await expect(
      page.getByRole("heading", { name: "Specs" }),
    ).toBeVisible({ timeout: 15_000 });

    // ac-1 / ac-5: the decoded glyph is shown; the raw entity is NOT rendered.
    await expect(page.getByText("Billing & Invoicing").first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/Billing &amp;/)).toHaveCount(0);

    // ── The doc detail heading is decoded too ──
    await page.goto(
      tenantPath(
        tenant.namespaceSlug,
        tenant.memexSlug,
        `/specs/${spec.handle}`,
      ),
      { waitUntil: "commit" },
    );
    await expect(
      page.getByRole("heading", { level: 1, name: /Billing & Invoicing/ }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Billing &amp;/)).toHaveCount(0);
  },
);

test(
  "a markdown comment body renders as markdown, not literal syntax (ac-6)",
  async ({ page, resources }) => {
    const tenant = await seedOrgTenant({ slug: resources.slug("j62b") });
    const spec = await seedSpec({
      memexId: tenant.memexId,
      title: "Comment Markdown Spec",
      purpose: "Exercise markdown rendering of comment bodies.",
    });
    await setDocStatus({
      memexId: tenant.memexId,
      docId: spec.docId,
      status: "specify",
    });

    // A comment body carrying markdown — bold + a link. Before spec-484 this
    // rendered as the literal string "**bold-text**"; now it must render as
    // real markdown (a <strong> and an <a>).
    await seedComment({
      memexId: tenant.memexId,
      target: "section",
      targetId: spec.sectionId,
      authorName: "Casey Comment",
      content: "**bold-text** and a [ref link](https://example.com)",
    });

    await page.goto(
      tenantPath(
        tenant.namespaceSlug,
        tenant.memexSlug,
        `/specs/${spec.handle}`,
      ),
      { waitUntil: "commit" },
    );
    await expect(
      page.getByRole("heading", { level: 1, name: /Comment Markdown Spec/ }),
    ).toBeVisible({ timeout: 15_000 });

    // Open the Comments sub-tab (same affordance journey-33 uses).
    await page
      .getByRole("button", { name: /^Comments?( \(\d+\))?$/ })
      .click();

    // The comment renders in the flat Comments view under its author byline.
    await expect(page.getByText("Casey Comment")).toBeVisible({
      timeout: 15_000,
    });

    // ac-6: markdown is RENDERED — "bold-text" is inside a <strong>, the link is
    // a real <a> carrying the parsed href — and the literal markdown syntax is
    // NOT shown as text.
    await expect(
      page.locator("strong", { hasText: "bold-text" }),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "ref link" })).toHaveAttribute(
      "href",
      "https://example.com",
    );
    await expect(page.getByText("**bold-text**")).toHaveCount(0);
  },
);
