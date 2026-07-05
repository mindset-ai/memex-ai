// spec-458 dec-13 (ac-21) — nearest-city snap + flag emoji for the map callout.
//
// Purely presentational and derived: the label is a function of the point's
// already-public, already-coarse coordinates against the checked-in Natural
// Earth asset. Nothing here reads the API, stores anything, or sharpens what a
// dot reveals (ac-3 unchanged). Approximate by design — a suburb labels as its
// nearby city, which the map's "locations approximate" caption already covers.

import { WORLD_CITIES } from './worldCities';

export interface CityLabel {
  name: string;
  /** Regional-indicator emoji, or '' when the place carries no ISO-A2 code. */
  flag: string;
}

/** ISO-A2 → regional-indicator emoji ("GB" → 🇬🇧). '' for anything non-A2. */
export function flagEmoji(iso2: string): string {
  if (!/^[A-Za-z]{2}$/.test(iso2)) return '';
  const base = 0x1f1e6; // 🇦
  const chars = iso2.toUpperCase();
  return (
    String.fromCodePoint(base + chars.charCodeAt(0) - 65) +
    String.fromCodePoint(base + chars.charCodeAt(1) - 65)
  );
}

/**
 * Nearest city by equirectangular-approximate distance (lat/lng degrees with a
 * cos(lat) longitude correction — plenty for a label on city-blob coords).
 * The asset is population-sorted, and `<` keeps the first (larger) city on
 * ties. Linear scan over 1,251 entries × ≤80 dots is negligible.
 */
export function nearestCity(lat: number, lng: number): CityLabel {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < WORLD_CITIES.length; i++) {
    const dLat = WORLD_CITIES[i][2] - lat;
    let dLng = WORLD_CITIES[i][3] - lng;
    // Antimeridian wrap: 179°E is 2° from 179°W, not 358°.
    if (dLng > 180) dLng -= 360;
    if (dLng < -180) dLng += 360;
    dLng *= cosLat;
    const d = dLat * dLat + dLng * dLng;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  const [name, iso2] = WORLD_CITIES[best];
  return { name, flag: flagEmoji(iso2) };
}
