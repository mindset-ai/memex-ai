// spec-171 t-4: HubSpot lead capture for Self-Hosted Enterprise contact form.
// Hand-rolled fetch — no npm package per std-13. Auth token from GCP Secret Manager per std-9.

const HUBSPOT_API = "https://api.hubapi.com/crm/v3/objects/contacts";

export interface SelfHostedContactInput {
  email: string;
  firstname: string;
  lastname: string;
  company: string;
  estimatedSeats: number;
  deploymentContext?: string;
}

/**
 * Create a HubSpot contact from a Self-Hosted Enterprise enquiry form submission.
 * On success or 409 (contact already exists) → resolves normally.
 * On HubSpot API failure → throws so the caller can trigger the fallback email.
 */
export async function createHubSpotContact(input: SelfHostedContactInput): Promise<void> {
  const apiKey = process.env.HUBSPOT_API_KEY;
  if (!apiKey) throw new Error("HUBSPOT_API_KEY is not set");

  const res = await fetch(HUBSPOT_API, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      properties: {
        email: input.email,
        firstname: input.firstname,
        lastname: input.lastname,
        company: input.company,
        hs_lead_status: "NEW",
        // numemployees is the closest standard HubSpot property for seat count
        numemployees: String(input.estimatedSeats),
        ...(input.deploymentContext
          ? { message: input.deploymentContext }
          : {}),
      },
    }),
  });

  // 409 = contact already exists — treat as success, don't throw
  if (res.status === 409) return;

  if (!res.ok) {
    const text = await res.text().catch(() => "<unreadable>");
    throw new Error(`HubSpot API failed (${res.status}): ${text}`);
  }
}
