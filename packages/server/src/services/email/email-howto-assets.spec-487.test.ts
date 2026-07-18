// spec-487 t-1 — the three per-email how-to video + poster URL constants must
// resolve to the shared hosted static-bucket path (spec-480 pattern), never a
// Drive link. The rendered-HTML side of ac-7 is covered by the per-email tests
// (t-2/t-3/t-5); this locks the constants themselves.
import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import {
  EMAIL_HOWTO_CREATE_SPEC,
  EMAIL_HOWTO_CONNECT_MCP,
  EMAIL_HOWTO_CONNECT_PEOPLE,
} from "./templates.js";

const AC = (n: number) => `mindset-prod/memex-building-itself/specs/spec-487/acs/ac-${n}`;
const BASE = "https://storage.googleapis.com/memex-ai-prod-app-static/media";

describe("spec-487 t-1 — hosted how-to video + poster constants (ac-7)", () => {
  const assets = [
    ["create-spec (Day-2)", EMAIL_HOWTO_CREATE_SPEC, "email-howto-create-spec"],
    ["connect-mcp (Day-3)", EMAIL_HOWTO_CONNECT_MCP, "email-howto-connect-mcp"],
    ["connect-people (Day-12)", EMAIL_HOWTO_CONNECT_PEOPLE, "email-howto-connect-people"],
  ] as const;

  for (const [name, asset, slug] of assets) {
    it(`${name}: video + both posters resolve to the shared hosted bucket path`, () => {
      tagAc(AC(7));
      expect(asset.videoUrl).toBe(`${BASE}/${slug}.mp4`);
      expect(asset.thumb1xUrl).toBe(`${BASE}/${slug}-thumb-480.png`);
      expect(asset.thumb2xUrl).toBe(`${BASE}/${slug}-thumb-960.png`);
    });

    it(`${name}: every URL is https and never a Drive link`, () => {
      tagAc(AC(7));
      for (const u of [asset.videoUrl, asset.thumb1xUrl, asset.thumb2xUrl]) {
        expect(u.startsWith("https://")).toBe(true);
        expect(u).not.toContain("drive.google.com");
      }
    });
  }
});
