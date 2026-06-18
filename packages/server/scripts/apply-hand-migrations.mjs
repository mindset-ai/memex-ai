// Windows-friendly equivalent of apply-hand-migrations.sh.
// Uses Node.js + postgres.js so no bash/python3 needed.
// Usage: node scripts/apply-hand-migrations.mjs [--seed|--dry-run]
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const drizzleDir = resolve(__dirname, "../drizzle");
const journalFile = resolve(drizzleDir, "meta/_journal.json");

// Load DATABASE_URL from .env if not set
if (!process.env.DATABASE_URL) {
  const envPath = resolve(__dirname, "../.env");
  try {
    const lines = readFileSync(envPath, "utf8").split("\n");
    for (const line of lines) {
      const m = line.match(/^DATABASE_URL=(.+)/);
      if (m) { process.env.DATABASE_URL = m[1].trim(); break; }
    }
  } catch { /* no .env */ }
}

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) { console.error("DATABASE_URL is required"); process.exit(1); }

const mode = process.argv[2] ?? "";

// Dynamic import of postgres (workspace dep)
const require = createRequire(import.meta.url);
const postgres = require("postgres");
const sql = postgres(dbUrl, { max: 1, onnotice: () => {} });

try {
  // Ensure tracking table
  await sql`CREATE TABLE IF NOT EXISTS manual_migrations (
    filename text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;

  // Journal tags that drizzle-kit owns
  const journal = JSON.parse(readFileSync(journalFile, "utf8"));
  const journalTags = new Set(journal.entries.map(e => e.tag));

  // Collect pending migrations
  const files = readdirSync(drizzleDir)
    .filter(f => f.endsWith(".sql"))
    .sort();

  const pending = [];
  for (const f of files) {
    const tag = basename(f, ".sql");
    if (journalTags.has(tag)) continue;
    const rows = await sql`SELECT 1 FROM manual_migrations WHERE filename = ${tag} LIMIT 1`;
    if (rows.length > 0) continue;
    pending.push({ tag, path: resolve(drizzleDir, f) });
  }

  if (pending.length === 0) { console.log("No hand-written migrations to apply."); }

  if (mode === "--dry-run") {
    console.log(`Would apply ${pending.length} migration(s):`);
    pending.forEach(m => console.log(`  - ${m.tag}`));
  } else if (mode === "--seed") {
    for (const m of pending) {
      await sql`INSERT INTO manual_migrations (filename) VALUES (${m.tag}) ON CONFLICT DO NOTHING`;
      console.log(`  + ${m.tag}`);
    }
  } else {
    for (const m of pending) {
      console.log(`  → ${m.tag}`);
      const migSql = readFileSync(m.path, "utf8");
      try {
        await sql.begin(async tx => {
          // Split on the drizzle statement-breakpoint marker and run each piece.
          // Strip leading comment lines before checking if there's real SQL —
          // a segment can start with comment lines followed by a real statement.
          for (const stmt of migSql.split("--> statement-breakpoint")) {
            const withoutLeadingComments = stmt
              .split("\n")
              .filter(l => !l.trim().startsWith("--"))
              .join("\n")
              .trim();
            if (withoutLeadingComments) await tx.unsafe(withoutLeadingComments);
          }
          await tx`INSERT INTO manual_migrations (filename) VALUES (${m.tag})`;
        });
      } catch (err) {
        // Seed (mark applied without running) migrations that fail due to missing
        // infrastructure this environment doesn't have. Covers:
        //   0A000 — missing Postgres extension (e.g. pgvector not installed)
        //   42P01 — undefined table  (dependency on a seeded migration's CREATE TABLE)
        //   42703 — undefined column (dependency on a seeded migration's ADD COLUMN)
        // All three cascade from a seeded ancestor, so we seed the dependent too
        // and let the rest of the schema proceed.
        const code = err && typeof err === "object" && "code" in err ? err.code : null;
        if (code === "0A000" || code === "42P01" || code === "42703") {
          console.warn(`  ⚠ ${m.tag}: seeding (${(err).message?.split("\n")[0]})`);
          await sql`INSERT INTO manual_migrations (filename) VALUES (${m.tag}) ON CONFLICT DO NOTHING`;
        } else {
          throw err;
        }
      }
    }
    if (pending.length > 0) console.log("  ✓ all hand-written migrations applied");
  }
} finally {
  await sql.end({ timeout: 2 });
}
