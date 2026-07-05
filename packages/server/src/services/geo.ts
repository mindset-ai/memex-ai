// spec-458 dec-9 — coarse geo capture from the GCLB custom request header.
//
// The prod/int HTTPS load balancer is configured (spec-458 t-6) to stamp
//   X-Client-Geo-Latlong: {client_city_lat_long}
// on requests to memex-api-backend. The variable renders as "lat,lng" (city
// centroid) or an empty string when GCLB can't resolve a location.
//
// Privacy posture (ac-3/ac-15): coordinates are rounded to ONE decimal degree
// (~11km city blob) HERE, before any caller can persist them — precise location
// never exists in our storage. No IP is read or written by this module. Traffic
// that bypasses the LB simply has no header → null coords.

export const GEO_LATLONG_HEADER = "x-client-geo-latlong";

export interface CoarseGeo {
  lat: number;
  lng: number;
}

/** Round to 1 decimal degree — the persistence-side coarseness floor. */
export function roundCoord(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Parse the LB geo header value into city-rounded coordinates.
 * Returns null for absent/empty/malformed/out-of-range values — callers
 * persist nulls rather than guessing.
 */
export function parseGeoHeader(value: string | null | undefined): CoarseGeo | null {
  if (!value) return null;
  const parts = value.split(",");
  if (parts.length !== 2) return null;
  const lat = Number(parts[0]?.trim());
  const lng = Number(parts[1]?.trim());
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
  return { lat: roundCoord(lat), lng: roundCoord(lng) };
}
