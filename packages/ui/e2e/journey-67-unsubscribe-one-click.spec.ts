import { test, expect, emitAcEvents } from "./helpers/index.js";
import {
  ensureUser,
  getUnsubscribeUrl,
  isLifecycleUnsubscribed,
} from "./helpers/seed.js";

// Journey 67 — one-click unsubscribe, end to end (spec-515 t-10 / ac-2, std-28 gate).
//
// WHY THIS JOURNEY EXISTS. `/api/email/unsubscribe` is the RFC 8058
// `List-Unsubscribe-Post` target carried on EVERY lifecycle email
// (services/email/sender.ts emits the header pair; unsubscribe-token.ts builds the
// URL). It 404'd in production from 2026-07-01 to 2026-07-28 — the tenant resolver
// swallowed it, because `email` was missing from the exempt API roots. The handler
// and its confirmation page had existed the whole time; they were simply
// unreachable. Nothing in the suite noticed, which is what std-28 exists to prevent.
//
// SCOPE — the whole chain, the way a mail client walks it:
//   1. the POST a mail client fires for one-click: no session, no CSRF token, no
//      page — must suppress the recipient on the strength of the token alone
//   2. the GET a human clicks in the body: must render a readable confirmation, not
//      raw JSON and not an error
//   3. the suppression must be what the SEND GATE reads — asserted through
//      `isLifecycleEmailUnsubscribed`, the same function `sendLifecycleEmail`
//      consults before any activation/win-back send, rather than through a column
//   4. a malformed token must be refused, and must say so legibly
//
// The URL under test is minted SERVER-SIDE by the real `unsubscribeUrl()` (via the
// env-gated test surface, per std-28 — no raw SQL). Hand-building it here would let
// the journey pass against a link the product never actually sends.
//
// NOT IN SCOPE: that a suppressed user is then skipped by a real send. That gate is
// `lifecycle-send.ts:38` and is covered by spec-427's own tests; re-proving it needs
// a send harness, not a browser. What this journey pins is that the link produces
// the state that gate reads.

const AC2 = "mindset-prod/memex-building-itself/specs/spec-515/acs/ac-2";

// Per-test unique so parallel workers and repeat runs cannot collide on the users
// table's unique email [per std-37 cl-1].
const stamp = () => `${process.env.TEST_WORKER_INDEX ?? "0"}-${Math.random().toString(36).slice(2, 10)}`;

test.afterEach(async ({}, testInfo) => {
  if (testInfo.status === "skipped") return;
  await emitAcEvents(
    [AC2],
    testInfo.status === "passed" ? "pass" : "fail",
    `packages/ui/e2e/journey-67-unsubscribe-one-click.spec.ts::${testInfo.title}`,
    testInfo.duration,
  );
});

test("the mail client's one-click POST suppresses the recipient with no session (ac-2)", async ({
  request,
}) => {
  const email = `s515-oneclick-${stamp()}@example.com`;
  await ensureUser(email);
  expect(await isLifecycleUnsubscribed(email)).toBe(false);

  const url = await getUnsubscribeUrl(email);
  // Sanity: the product's own URL builder must still target the path this Spec
  // repaired. If it ever moves, this journey should say so rather than silently
  // testing a different endpoint.
  expect(url).toContain("/api/email/unsubscribe?token=");

  // Exactly what Gmail/Apple Mail send for List-Unsubscribe-Post: a bare POST with
  // the one-click marker in the body, no cookies, no CSRF token, no Referer.
  const res = await request.post(url, {
    form: { "List-Unsubscribe": "One-Click" },
  });
  expect(res.status()).toBe(200);

  expect(await isLifecycleUnsubscribed(email)).toBe(true);
});

test("the in-body GET link renders a readable confirmation, not JSON (ac-2)", async ({
  page,
}) => {
  const email = `s515-getlink-${stamp()}@example.com`;
  await ensureUser(email);
  const url = await getUnsubscribeUrl(email);

  await page.goto(url);
  // A human landing here must understand what happened. Asserting on the rendered
  // heading rather than the status code is the point: a 200 carrying raw JSON would
  // satisfy the endpoint and fail the person reading it.
  await expect(page.getByRole("heading", { name: /unsubscribed/i })).toBeVisible({
    timeout: 15_000,
  });
  // And it must say what still sends, so nobody thinks account email stopped too.
  await expect(page.getByText(/sign-in links/i)).toBeVisible();

  expect(await isLifecycleUnsubscribed(email)).toBe(true);
});

test("unsubscribing twice is idempotent — the second visit still confirms (ac-2)", async ({
  page,
}) => {
  // A mail-client link scanner may prefetch the URL before the human clicks it, so
  // the second visit is the NORMAL case, not an edge case. It must not error.
  const email = `s515-twice-${stamp()}@example.com`;
  await ensureUser(email);
  const url = await getUnsubscribeUrl(email);

  await page.goto(url);
  await expect(page.getByRole("heading", { name: /unsubscribed/i })).toBeVisible({
    timeout: 15_000,
  });
  await page.goto(url);
  await expect(page.getByRole("heading", { name: /unsubscribed/i })).toBeVisible();

  expect(await isLifecycleUnsubscribed(email)).toBe(true);
});

test("a malformed token is refused and says so legibly (ac-2)", async ({ page }) => {
  const email = `s515-badtoken-${stamp()}@example.com`;
  await ensureUser(email);

  // Derive the origin from the product's OWN builder and corrupt only the token —
  // hardcoding a host here would bake in an assumption the helpers already own.
  const forged = (await getUnsubscribeUrl(email)).replace(
    /token=.*$/,
    "token=not-a-real-token",
  );
  const res = await page.goto(forged);
  expect(res?.status()).toBe(400);
  await expect(page.getByRole("heading", { name: /isn't valid/i })).toBeVisible();

  // The decisive half: a forged token must not suppress anyone.
  expect(await isLifecycleUnsubscribed(email)).toBe(false);
});
