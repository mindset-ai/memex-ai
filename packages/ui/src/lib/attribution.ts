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

export function readAttributionCookie(): AttributionData | null {
  try {
    const m = document.cookie.match(/(?:^|; )_memex_attribution=([^;]*)/);
    if (!m) return null;
    return JSON.parse(decodeURIComponent(m[1])) as AttributionData;
  } catch {
    return null;
  }
}

export function pushDataLayer(event: Record<string, unknown>): void {
  try {
    const w = window as unknown as Record<string, unknown>;
    w.dataLayer = w.dataLayer ?? [];
    (w.dataLayer as unknown[]).push(event);
  } catch {
    // never throw from analytics
  }
}
