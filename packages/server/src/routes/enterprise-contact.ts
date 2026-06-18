// spec-171 t-4: Self-Hosted Enterprise contact form endpoint.
//
// POST /api/enterprise/self-hosted/contact — no auth (public form).
// Submits lead to HubSpot; on HubSpot failure sends fallback email to sales@memex.ai
// so no enquiry is silently lost.

import { Hono } from "hono";
import { createHubSpotContact } from "../services/hubspot.js";
import { getEmailSender } from "../services/email/sender.js";
import { ValidationError } from "../types/errors.js";

const enterpriseContactRouter = new Hono();

enterpriseContactRouter.post("/", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return c.json({ error: "Invalid JSON body" }, 400);

  const { email, firstname, lastname, company, estimatedSeats, deploymentContext } = body;

  const errors: string[] = [];
  if (typeof email !== "string" || !email.trim()) errors.push("email is required");
  if (typeof firstname !== "string" || !firstname.trim()) errors.push("firstname is required");
  if (typeof lastname !== "string" || !lastname.trim()) errors.push("lastname is required");
  if (typeof company !== "string" || !company.trim()) errors.push("company is required");
  if (typeof estimatedSeats !== "number" || estimatedSeats < 1) errors.push("estimatedSeats must be a positive number");

  if (errors.length > 0) {
    return c.json({ error: "Validation failed", details: errors }, 400);
  }

  const input = {
    email: (email as string).trim().toLowerCase(),
    firstname: (firstname as string).trim(),
    lastname: (lastname as string).trim(),
    company: (company as string).trim(),
    estimatedSeats: estimatedSeats as number,
    deploymentContext: typeof deploymentContext === "string" ? deploymentContext.trim() : undefined,
  };

  try {
    await createHubSpotContact(input);
  } catch (err) {
    // HubSpot is down or errored — send fallback email to sales so no lead is lost.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[enterprise-contact] HubSpot failed, sending fallback email: ${message}`);

    await getEmailSender()
      .send({
        to: "support@memex.ai",
        subject: `[Self-Hosted Enquiry] ${input.company} — ${input.email}`,
        text: [
          `New Self-Hosted Enterprise enquiry (HubSpot unavailable — manual follow-up required)`,
          ``,
          `Name: ${input.firstname} ${input.lastname}`,
          `Email: ${input.email}`,
          `Company: ${input.company}`,
          `Estimated seats: ${input.estimatedSeats}`,
          input.deploymentContext ? `Deployment context: ${input.deploymentContext}` : "",
          ``,
          `Memex.AI`,
        ]
          .filter((line) => line !== undefined)
          .join("\n"),
      })
      .catch((emailErr) =>
        console.error("[enterprise-contact] Fallback email also failed:", emailErr),
      );
  }

  // Always return 200 — caller shouldn't see an error even if HubSpot is down
  return c.json({ received: true });
});

export { enterpriseContactRouter };
