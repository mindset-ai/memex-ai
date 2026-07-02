// Journey 54 — verification-email resend cooldown (duplicate-verification-email fix).
//
// Bug: a new signup could receive several verification emails in seconds because the
// VerifyEmailGate "Resend" button had no visible cooldown — it re-enabled the moment
// each request returned. The fix pairs a server-side 60s cooldown
// (auth-rate-limit resendVerificationCooldown) with a client countdown: after one send
// the button relabels to "Resend in Ns" and stays disabled for the window.
//
// This journey drives the gate as a real, UNVERIFIED user and asserts the button enters
// that cooldown after a single resend. No Spec/AC is attached — it's a contained bug
// fix — so it emits no AC events; it runs purely as a PR-gate behavioural guard.
//
// Reaching the gate: in e2e/dev the app auto-authenticates token-less requests as
// dev@memex.ai (verified), so the login form is unreachable. Instead we hit the real
// signup endpoint from the page context and store the returned session JWT exactly as
// acceptSession would; on reload the gate renders because emailVerified=false.

import { test, expect, bareUrl } from "./helpers/index.js";

test(
  "one resend puts the button into a visible 60s cooldown (no bursty re-sends)",
  async ({ page, resources }) => {
    const email = resources.email("resend-cooldown");
    const password = "correct-horse-battery-staple-9";

    await page.goto(bareUrl("/"), { waitUntil: "commit" });

    // Sign up a fresh (unverified) user via the real endpoint and plant the session.
    await page.evaluate(
      async ({ email, password }) => {
        const res = await fetch("/api/auth/signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        });
        const session = await res.json();
        localStorage.setItem("memex-auth-token", session.token);
        localStorage.setItem("memex-session", JSON.stringify(session));
      },
      { email, password },
    );

    await page.reload({ waitUntil: "commit" });

    // The unverified user lands on the confirm-email gate.
    await expect(
      page.getByRole("heading", { name: "Confirm your email" }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(email)).toBeVisible();

    const resendBtn = page.getByRole("button", { name: "Resend email" });
    await expect(resendBtn).toBeEnabled();
    await resendBtn.click();

    // Send succeeded — the success alert shows and the button drops into the cooldown.
    await expect(page.getByText(/Sent a new link/)).toBeVisible({ timeout: 15_000 });

    // The cooldown is visible (relabelled "Resend in Ns") and disabled, so an impatient
    // user cannot fire a second send — the client half of the duplicate-email fix.
    const coolingBtn = page.getByRole("button", { name: /Resend in \d+s/ });
    await expect(coolingBtn).toBeVisible({ timeout: 10_000 });
    await expect(coolingBtn).toBeDisabled();
  },
);
