// Server-to-server conversion API calls for spec-21 t-5.
// All calls are non-blocking — callers fire-and-forget. Silently skips when
// required env vars are absent so dev/staging environments don't error.

import type { AttributionData } from "./attribution.js";

export interface ConversionParams {
  email: string;
  hashedEmail: string;
  eventId: string;
  attribution: AttributionData;
  conversionDateTime: string; // ISO 8601, e.g. "2026-06-27T12:00:00+00:00"
}

// Google Ads Enhanced Conversions (offline click conversion upload).
// Required env vars: GOOGLE_ADS_ACCESS_TOKEN, GOOGLE_ADS_DEVELOPER_TOKEN,
//   GOOGLE_ADS_CUSTOMER_ID, GOOGLE_ADS_CONVERSION_ACTION_ID
export async function fireGoogleAdsConversion(params: ConversionParams): Promise<void> {
  const token = process.env.GOOGLE_ADS_ACCESS_TOKEN;
  const devToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const customerId = process.env.GOOGLE_ADS_CUSTOMER_ID;
  const actionId = process.env.GOOGLE_ADS_CONVERSION_ACTION_ID;
  if (!token || !devToken || !customerId || !actionId) return;
  if (!params.attribution.gclid) return;

  const url = `https://googleads.googleapis.com/v17/customers/${customerId}:uploadClickConversions`;
  await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "developer-token": devToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      conversions: [{
        gclid: params.attribution.gclid,
        conversionAction: `customers/${customerId}/conversionActions/${actionId}`,
        conversionDateTime: params.conversionDateTime,
        hashedEmailAddress: params.hashedEmail,
      }],
      partialFailure: true,
    }),
  }).then(async (res) => {
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[spec-21] Google Ads conversion upload failed (${res.status}):`, body.slice(0, 200));
    }
  }).catch((err) => {
    console.error("[spec-21] Google Ads conversion upload error:", err instanceof Error ? err.message : String(err));
  });
}

// LinkedIn Conversions API (server-side event).
// Required env vars: LINKEDIN_ACCESS_TOKEN, LINKEDIN_AD_ACCOUNT_ID, LINKEDIN_CONVERSION_ID
export async function fireLinkedInConversion(params: ConversionParams): Promise<void> {
  const token = process.env.LINKEDIN_ACCESS_TOKEN;
  const adAccountId = process.env.LINKEDIN_AD_ACCOUNT_ID;
  const conversionId = process.env.LINKEDIN_CONVERSION_ID;
  if (!token || !adAccountId || !conversionId) return;

  const userIds: { idType: string; idValue: string }[] = [
    { idType: "SHA256_EMAIL", idValue: params.hashedEmail },
  ];
  if (params.attribution.li_fat_id) {
    userIds.push({ idType: "LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID", idValue: params.attribution.li_fat_id });
  }

  await fetch("https://api.linkedin.com/rest/conversionEvents", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Restli-Protocol-Version": "2.0.0",
      "LinkedIn-Version": "202409",
    },
    body: JSON.stringify({
      conversion: `urn:lla:llaPartnerConversion:${conversionId}`,
      conversionHappenedAt: Date.now(),
      eventId: params.eventId,
      user: { userIds },
    }),
  }).then(async (res) => {
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[spec-21] LinkedIn conversion upload failed (${res.status}):`, body.slice(0, 200));
    }
  }).catch((err) => {
    console.error("[spec-21] LinkedIn conversion upload error:", err instanceof Error ? err.message : String(err));
  });
}

// OpenAI advertising pixel — server-side conversion event.
// Required env vars: OPENAI_PIXEL_ID, OPENAI_PIXEL_API_KEY
export async function fireOpenAiConversion(params: ConversionParams): Promise<void> {
  const pixelId = process.env.OPENAI_PIXEL_ID;
  const apiKey = process.env.OPENAI_PIXEL_API_KEY;
  if (!pixelId || !apiKey) return;
  if (!params.attribution.oppref) return;

  await fetch(`https://bzrapi.openai.com/v1/pixels/${pixelId}/events`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      event_name: "registration_completed",
      event_id: params.eventId,
      event_time: Math.floor(Date.now() / 1000),
      user_data: { em: params.hashedEmail },
      custom_data: { oppref: params.attribution.oppref },
    }),
  }).then(async (res) => {
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[spec-21] OpenAI conversion upload failed (${res.status}):`, body.slice(0, 200));
    }
  }).catch((err) => {
    console.error("[spec-21] OpenAI conversion upload error:", err instanceof Error ? err.message : String(err));
  });
}

// Fires all three conversion APIs for a new account. Non-blocking — does NOT
// await individual calls; errors are logged but never surfaced to the caller.
export function fireAllConversions(params: ConversionParams): void {
  fireGoogleAdsConversion(params).catch(() => {});
  fireLinkedInConversion(params).catch(() => {});
  fireOpenAiConversion(params).catch(() => {});
}
