// spec-458 t-7 — nearest-city snap + flag emoji for the map callout (ac-21).
//
// The label must be a pure derivation from a dot's public coarse coordinates:
// correct snaps on known (and jittered) coords, correct flags, graceful
// no-flag fallback, antimeridian sanity — and no city/flag field anywhere in
// the wire types (the server-side payload-shape tests pin the API half; here
// we pin the client half).

import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { nearestCity, flagEmoji } from './cities';
import { WORLD_CITIES } from './worldCities';

const AC = 'mindset-prod/memex-building-itself/specs/spec-458/acs';

describe('nearestCity — derived, approximate, correct', () => {
  it('snaps known coords (and their jittered city-blob variants) to the expected city', () => {
    tagAc(`${AC}/ac-21`);
    expect(nearestCity(51.5, -0.1)).toEqual({ name: 'London', flag: '🇬🇧' });
    expect(nearestCity(40.75, -73.98).name).toBe('New York');
    expect(nearestCity(35.69, 139.75)).toEqual({ name: 'Tokyo', flag: '🇯🇵' });
    expect(nearestCity(-33.87, 151.21)).toEqual({ name: 'Sydney', flag: '🇦🇺' });
    // The read-side jitter (≤0.15°) + write-side rounding (0.1°) never moves a
    // dot to a different metropolis.
    expect(nearestCity(51.62, -0.24).name).toBe('London');
    expect(nearestCity(35.55, 139.9).name).toBe('Tokyo');
  });

  it('handles the antimeridian: a dot at 179°W snaps across the wrap, not around the globe', () => {
    tagAc(`${AC}/ac-21`);
    // Suva, Fiji (178.44°E) is the nearest place to 18°S 179°W across the wrap.
    const city = nearestCity(-18.1, -179.0);
    expect(city.name).toBe('Suva');
  });

  it('every asset entry is [name, iso2, lat, lng] with sane ranges', () => {
    tagAc(`${AC}/ac-21`);
    expect(WORLD_CITIES.length).toBeGreaterThan(1000);
    for (const [name, iso2, lat, lng] of WORLD_CITIES) {
      expect(name.length).toBeGreaterThan(0);
      expect(iso2 === '' || /^[A-Z]{2}$/.test(iso2)).toBe(true);
      expect(Math.abs(lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(lng)).toBeLessThanOrEqual(180);
    }
  });
});

describe('flagEmoji', () => {
  it('maps ISO-A2 to regional indicators; anything else to no flag', () => {
    tagAc(`${AC}/ac-21`);
    expect(flagEmoji('GB')).toBe('🇬🇧');
    expect(flagEmoji('us')).toBe('🇺🇸');
    expect(flagEmoji('')).toBe('');
    expect(flagEmoji('-99')).toBe('');
    expect(flagEmoji('GBR')).toBe('');
  });
});

describe('no city/flag field crosses the wire (ac-21 — derived only)', () => {
  it('the client MapPoint type carries only lat/lng/kind/weight', () => {
    tagAc(`${AC}/ac-21`);
    const page = readFileSync(join(process.cwd(), 'src/pages/live/LivePage.tsx'), 'utf8');
    const mapPoint = page.match(/interface MapPoint \{([\s\S]*?)\}/)?.[1] ?? '';
    expect(mapPoint).not.toMatch(/city|flag|place|country/i);
    // The callout derives via nearestCity at render time.
    expect(page).toContain('nearestCity(');
  });
});
