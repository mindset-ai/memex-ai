import { createHash, randomUUID } from "node:crypto";
import { db } from "../db/connection.js";
import { userAttributions } from "../db/schema.js";
import { mutate, type RequestCtx } from "./mutate.js";

export interface AttributionData {
  gclid?: string;
  li_fat_id?: string;
  oppref?: string;
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
}

export function parseAttributionCookie(cookieHeader: string | null | undefined): AttributionData | null {
  if (!cookieHeader) return null;
  try {
    const m = cookieHeader.match(/(?:^|; )_memex_attribution=([^;]*)/);
    if (!m) return null;
    const parsed = JSON.parse(decodeURIComponent(m[1]));
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as AttributionData;
  } catch {
    return null;
  }
}

export function hashEmail(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

// Persists attribution data for a new account. Generates a server-side event_id
// used to deduplicate server-to-server conversion API calls.
// Returns the event_id so callers can pass it to conversion-api fire calls.
export async function saveAttribution(
  userId: string,
  data: AttributionData,
  ctx: RequestCtx = {},
): Promise<string> {
  const eventId = randomUUID();
  await mutate(
    ctx,
    { memexId: "", userId, entity: "user_attribution", action: "created" },
    async () => {
      await db.insert(userAttributions).values({
        userId,
        eventId,
        gclid: data.gclid ?? null,
        liFatId: data.li_fat_id ?? null,
        oppref: data.oppref ?? null,
        utmSource: data.utm_source ?? null,
        utmMedium: data.utm_medium ?? null,
        utmCampaign: data.utm_campaign ?? null,
        utmContent: data.utm_content ?? null,
        utmTerm: data.utm_term ?? null,
      });
    },
    { silent: true },
  );
  return eventId;
}
