// spec-372 dec-3 / t-6 — reversible removal of the graduated-home surfaces.
//
// "Where you're needed" + "Your specs" (HomeValue, spec-315) and the "Your Journeys" pearls
// (YourJourneys, spec-312) are hidden on Home "until we can make them look better and more
// meaningful" (Ryan). This is a RENDER-only switch: the components and the spec-312/315
// graduation/journeys state logic are kept intact, so flipping this back to `true` reinstates
// the surfaces with no rebuild.
//
// It lives in its own module so the spec-312/315 integration tests can mock it ON to prove
// those surfaces (and Wic's ACs) still work, while the shipped default is OFF.
//
// ⚠ The surfaces belong to spec-312/315 (Wic) — do NOT merge the removal without his sign-off.
export const SHOW_GRADUATED_HOME: boolean = false;
