import { Hono } from "hono";
import { addWaitlistEntry } from "../services/waitlist.js";
import { getEmailSender } from "../services/email/sender.js";
import { buildWaitlistConfirmationEmail } from "../services/email/templates.js";
import { ValidationError } from "../types/errors.js";

const waitlist = new Hono();

// POST /api/waitlist
waitlist.post("/", async (c) => {
  // Per b-9: waitlist signups moved from int to prod (data migrated 2026-05-20).
  // Int sets WAITLIST_DISABLED=1 so any clients still pointed at int.memex.ai
  // fail loud rather than silently writing to a dead-end environment.
  if (process.env.WAITLIST_DISABLED === "1") {
    return c.json(
      { error: "This endpoint has moved. Please update to https://memex.ai/api/waitlist." },
      410,
    );
  }
  const body = await c.req.json().catch(() => {
    throw new ValidationError("Request body must be valid JSON");
  });
  // Unauthenticated public signup (marketing form) — no acting user. The
  // channel enum has no anonymous form, but this IS a REST surface, so the
  // closest honest attribution is rest_ui (vs the channel:'server' default that
  // would mislabel a user-driven signup as a system write). spec-156 FINDING 3.
  const entry = await addWaitlistEntry(
    {
      name: body?.name,
      company: body?.company,
      email: body?.email,
      deployment: body?.deployment,
    },
    { channel: "rest_ui" },
  );

  // Fire-and-forget: a failed confirmation email should not fail the signup.
  getEmailSender()
    .send(
      buildWaitlistConfirmationEmail({
        to: entry.email,
        name: entry.name,
        company: entry.company,
      }),
    )
    .catch((err) => console.error("Failed to send waitlist confirmation:", err));

  return c.json({ id: entry.id, createdAt: entry.createdAt }, 201);
});

export { waitlist };
