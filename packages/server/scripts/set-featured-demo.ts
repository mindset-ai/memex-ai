// spec-500 — the per-environment operator step that turns a Memex into the
// "Explore" featured entry. Sets `memexes.is_featured_demo` for one Memex,
// resolved by its `<namespace>/<memex>` slugs, through the real service (so the
// write goes through mutate() and emits on the unified bus, std-8).
//
// The intended target is `mindset-prod/memex-building-itself` (dec-8): flip it
// ON once per environment (int, then prod). This creates NO new memex/org — it
// only flips a flag on the EXISTING row.
//
// Usage:
//   pnpm --filter @memex/server tsx scripts/set-featured-demo.ts <namespace> <memex> [on|off]
//   # default action is "on"
//   pnpm --filter @memex/server tsx scripts/set-featured-demo.ts mindset-prod memex-building-itself on

import { eq, and } from "drizzle-orm";
import { db } from "../src/db/connection.js";
import { memexes, namespaces } from "../src/db/schema.js";
import { setFeaturedDemo } from "../src/services/memexes.js";

async function main(): Promise<void> {
  const [namespaceSlug, memexSlug, action = "on"] = process.argv.slice(2);
  if (!namespaceSlug || !memexSlug) {
    console.error(
      "Usage: tsx scripts/set-featured-demo.ts <namespace> <memex> [on|off]",
    );
    process.exit(1);
  }
  const isFeatured = action !== "off";

  const [row] = await db
    .select({ id: memexes.id, visibility: memexes.visibility })
    .from(memexes)
    .innerJoin(namespaces, eq(memexes.namespaceId, namespaces.id))
    .where(and(eq(namespaces.slug, namespaceSlug), eq(memexes.slug, memexSlug)));

  if (!row) {
    console.error(`[set-featured-demo] no memex found at ${namespaceSlug}/${memexSlug}`);
    process.exit(1);
  }
  if (isFeatured && row.visibility !== "public") {
    console.warn(
      `[set-featured-demo] ⚠ ${namespaceSlug}/${memexSlug} is '${row.visibility}', not 'public'. ` +
        `The featured channel only surfaces PUBLIC memexes — set visibility=public too, or it won't appear.`,
    );
  }

  await setFeaturedDemo(row.id, isFeatured, { channel: "server" });
  console.log(
    `[set-featured-demo] ${namespaceSlug}/${memexSlug} → is_featured_demo=${isFeatured}`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error("[set-featured-demo] failed:", err);
  process.exit(1);
});
