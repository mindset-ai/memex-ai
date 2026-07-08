// spec-458 t-2 — LB geo-header parsing + the persistence-side coarseness floor (ac-15).
import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { parseGeoHeader, roundCoord } from "./geo.js";

const AC = "mindset-prod/memex-building-itself/specs/spec-458/acs";

describe("parseGeoHeader — coarse by construction", () => {
  it("parses 'lat,lng' and rounds to 1 decimal degree before anything can persist", () => {
    tagAc(`${AC}/ac-15`);
    tagAc(`${AC}/ac-3`);
    expect(parseGeoHeader("51.507351,-0.127758")).toEqual({ lat: 51.5, lng: -0.1 });
    expect(parseGeoHeader(" 40.712776 , -74.005974 ")).toEqual({ lat: 40.7, lng: -74 });
    expect(roundCoord(-33.86882)).toBe(-33.9);
  });

  it("returns null for absent, empty, malformed, or out-of-range values", () => {
    tagAc(`${AC}/ac-15`);
    expect(parseGeoHeader(null)).toBeNull();
    expect(parseGeoHeader(undefined)).toBeNull();
    expect(parseGeoHeader("")).toBeNull();
    expect(parseGeoHeader("not-a-location")).toBeNull();
    expect(parseGeoHeader("51.5")).toBeNull();
    expect(parseGeoHeader("51.5,-0.1,extra")).toBeNull();
    expect(parseGeoHeader("91,0")).toBeNull();
    expect(parseGeoHeader("0,181")).toBeNull();
    expect(parseGeoHeader("NaN,0")).toBeNull();
  });
});
