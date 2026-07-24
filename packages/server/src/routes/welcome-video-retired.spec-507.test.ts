// spec-507 dec-2 — the welcome-video write path is retired; the column is not.
//
// The asymmetry is deliberate and load-bearing: deleting the behaviour makes this
// Spec a clean `git revert`, while dropping `users.video_welcomed_at` would make a
// revert lossy (every user who had already dismissed would be shown the video again)
// and would force a matching change in the published @memex/db-schema package.
//
// These are source/schema-level assertions rather than HTTP calls: the claim is
// "this surface no longer exists", and a 404 from a router that was never mounted
// is indistinguishable from a 404 for any other reason. Asserting on the mount and
// the schema pins the actual contract.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tagAc } from "@memex-ai-ac/vitest";
import { users } from "../db/schema.js";
import {
  EMAIL_EXPLAINER_VIDEO_URL,
  EMAIL_VIDEO_THUMB_1X_URL,
  EMAIL_VIDEO_THUMB_2X_URL,
} from "../services/email/templates.js";

const AC_ROUTE_GONE = "mindset-prod/memex-building-itself/specs/spec-507/acs/ac-11";
const AC_COLUMN_KEPT = "mindset-prod/memex-building-itself/specs/spec-507/acs/ac-12";
const AC_EMAILS_INTACT = "mindset-prod/memex-building-itself/specs/spec-507/acs/ac-4";

const ROUTES_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_SRC = join(ROUTES_DIR, "..");
const appSource = readFileSync(join(SERVER_SRC, "app.ts"), "utf8");
const usersServiceSource = readFileSync(join(SERVER_SRC, "services", "users.ts"), "utf8");
const testRouterSource = readFileSync(join(ROUTES_DIR, "__test__.ts"), "utf8");

describe("spec-507 ac-11: PATCH /api/welcome-video no longer exists", () => {
  it("is not mounted in app.ts", () => {
    tagAc(AC_ROUTE_GONE);
    expect(appSource).not.toContain('app.route("/api/welcome-video"');
    expect(appSource).not.toContain("routes/welcome-video.js");
  });

  it("has no router module left on disk", () => {
    tagAc(AC_ROUTE_GONE);
    expect(() => readFileSync(join(ROUTES_DIR, "welcome-video.ts"), "utf8")).toThrow();
  });

  it("no longer exposes markVideoWelcomed from the users service", () => {
    tagAc(AC_ROUTE_GONE);
    expect(usersServiceSource).not.toContain("markVideoWelcomed");
  });

  it("drops the /__test__/video-welcomed seeding surface", () => {
    tagAc(AC_ROUTE_GONE);
    expect(testRouterSource).not.toContain('testOnlyRouter.post("/video-welcomed"');
  });
});

describe("spec-507 ac-12: users.video_welcomed_at survives as history", () => {
  it("is still a column on the users table", () => {
    tagAc(AC_COLUMN_KEPT);
    expect(users.videoWelcomedAt).toBeDefined();
    expect(users.videoWelcomedAt.name).toBe("video_welcomed_at");
  });

  it("is still nullable — no backfill, no new constraint", () => {
    tagAc(AC_COLUMN_KEPT);
    expect(users.videoWelcomedAt.notNull).toBe(false);
  });

  it("keeps its original migration and adds no new one for this Spec", () => {
    tagAc(AC_COLUMN_KEPT);
    const drizzleDir = join(SERVER_SRC, "..", "drizzle");
    const original = readFileSync(join(drizzleDir, "0122_add_video_welcomed_at.sql"), "utf8");
    expect(original).toContain("video_welcomed_at");
    // A drop would have to land as a new migration naming the column.
    const dropMigrations = readdirSync(drizzleDir)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => {
        const sql = readFileSync(join(drizzleDir, f), "utf8").toLowerCase();
        return sql.includes("drop column") && sql.includes("video_welcomed_at");
      });
    expect(dropMigrations).toEqual([]);
  });
});

describe("spec-507 ac-4: the email video path is untouched (out of scope)", () => {
  it("the welcome/win-back emails keep their own hosted video + thumbnail assets", () => {
    tagAc(AC_EMAILS_INTACT);
    // These are a DIFFERENT asset (email-explainer-60s.mp4) from the in-app
    // welcome-to-memex video — spec-480/spec-488 own them, and this Spec neither
    // moves nor deletes them. If a refactor accidentally routed the email through
    // the retired /welcome plumbing, one of these constants would go missing.
    expect(EMAIL_EXPLAINER_VIDEO_URL).toContain("email-explainer-60s.mp4");
    expect(EMAIL_VIDEO_THUMB_1X_URL).toContain("email-video-thumb-480.png");
    expect(EMAIL_VIDEO_THUMB_2X_URL).toContain("email-video-thumb-960.png");
  });
});
