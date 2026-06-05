// One-off sample-data seeder for the spec-179 standards network map.
//
// Creates a batch of fictional-but-plausible standards in a target memex and
// cross-references them through REAL clause writes (addClausesToSection), so
// clause_refs materializes through the production write path — exactly what
// the /analytics/standards-graph endpoint joins. Topology is deliberately
// varied: a hub everyone cites, chains, a tight cluster, and one isolated
// node, plus spec/decision mentions that populate clause_refs without
// producing standard↔standard edges.
//
// Usage (from packages/server):
//   pnpm exec tsx scripts/seed-standards-graph-sample.ts [namespace/memex]
// Defaults to barrie/personal. Idempotent-ish: re-running creates ANOTHER
// batch (handles keep counting up) — drop the docs to reset.

import "dotenv/config";
import { eq, and } from "drizzle-orm";
import { db } from "../src/db/connection.js";
import { memexes, namespaces } from "../src/db/schema.js";
import { createStandard } from "../src/services/standards.js";
import { addClausesToSection } from "../src/services/clauses.js";

const target = process.argv[2] ?? "barrie/personal";
const [nsSlug, mxSlug] = target.split("/");

// Titles + the clause bodies each standard will carry. `{X}` placeholders are
// replaced with the real allocated handles after all standards exist, so the
// cross-references always cite real std-N handles regardless of where the
// per-memex counter currently stands.
const STANDARDS: Array<{ key: string; title: string; clauses: string[] }> = [
  {
    key: "api",
    title: "API design — resources, verbs, errors",
    clauses: [
      "Every endpoint is resource-shaped; verbs come from HTTP, never from the path.",
      "Errors return a structured body with a stable machine code; prose is for humans only.",
      "Pagination is keyset-based everywhere — offset pagination is forbidden per {perf}.",
    ],
  },
  {
    key: "routing",
    title: "Routing — path-based tenancy",
    clauses: [
      "Tenant routing is path-based on the apex domain, never subdomains.",
      "Every route resolves through the shared resolver before any handler runs; see {api} for the surface it feeds.",
      "Unknown tenants 404 per {authz} — existence must not leak.",
    ],
  },
  {
    key: "authz",
    title: "Authorization — 404 over 403",
    clauses: [
      "Unauthorized resource access returns 404, not 403 — never confirm existence.",
      "Membership checks live in middleware, not handlers; {routing} resolves the tenant first.",
      "Service-to-service calls authenticate with scoped tokens; see {secrets} for storage.",
    ],
  },
  {
    key: "secrets",
    title: "Secrets — storage and rotation",
    clauses: [
      "Secrets live in the platform secret manager, never in code or env-committed files.",
      "Rotation requires a redeploy; document each secret's blast radius.",
      "Local development uses dev-bypass fallbacks so real secrets stay out of laptops, per {testing}.",
    ],
  },
  {
    key: "testing",
    title: "Testing — isolation and tiers",
    clauses: [
      "Tests never touch the dev database; each worktree derives an isolated test database.",
      "Every mutation path needs an integration test against real Postgres — mocks prove nothing about SQL; see {mutations}.",
      "Static regression gates police conventions the type system can't, per {api} and {vocab}.",
    ],
  },
  {
    key: "mutations",
    title: "Mutations — single write path",
    clauses: [
      "Every DB write goes through the mutate() wrapper and emits on the unified bus.",
      "Composite writes emit one event per logical change; see {testing} for the coverage gates.",
      "Read paths never write — analytics aggregates per {api} are SELECT-only.",
    ],
  },
  {
    key: "perf",
    title: "Performance — budgets and indexes",
    clauses: [
      "Every list query is indexed for its access pattern; EXPLAIN before merging.",
      "Aggregations happen in SQL, not application code — see {mutations} for the read/write split.",
      "P95 budgets: API reads 200ms, writes 500ms. Regressions block deploys per spec-9 dec-2.",
    ],
  },
  {
    key: "vocab",
    title: "Vocabulary — one name per concept",
    clauses: [
      "Each domain concept has exactly one name across code, UI, and docs.",
      "Renames are hard cutovers with migrations, never aliases; see dec-3 for the precedent.",
      "Legacy vocabulary is policed by a static scan, per {testing}.",
    ],
  },
  {
    key: "observability",
    title: "Observability — logs, traces, budgets",
    clauses: [
      "Every request carries a request id from edge to DB; logs are structured JSON.",
      "The bus is the observability spine — counters diverging from writes means a bypass, per {mutations}.",
      "Per-domain debug logs follow the shared convention; see {api} for surfacing errors and spec-23 for the Slack sink.",
    ],
  },
  {
    key: "deploys",
    title: "Deploys — JIT access, smoke gates",
    clauses: [
      "Deployers hold no standing roles; all access is JIT via PAM entitlements per {secrets}.",
      "Smoke tests run against live envs after every deploy — int green before prod, per {testing}.",
      "Migrations are owned by deploy scripts; hand-run DDL is forbidden, see {mutations}.",
    ],
  },
  {
    key: "a11y",
    title: "Accessibility — keyboard and contrast",
    clauses: [
      "Every interactive element is keyboard-reachable and visibly focused.",
      "Color contrast meets WCAG AA in both themes; charts carry text equivalents.",
    ],
  },
  // Isolated node — cites nothing, cited by nothing.
  {
    key: "naming",
    title: "File naming — kebab-case everywhere",
    clauses: [
      "Source files are kebab-case; no spaces, no camelCase filenames.",
      "Test files sit next to their subject with a .test suffix.",
    ],
  },
];

async function main() {
  const [row] = await db
    .select({ memexId: memexes.id })
    .from(memexes)
    .innerJoin(namespaces, eq(namespaces.id, memexes.namespaceId))
    .where(and(eq(namespaces.slug, nsSlug), eq(memexes.slug, mxSlug)));
  if (!row) throw new Error(`Memex ${target} not found`);
  const memexId = row.memexId;
  console.log(`Seeding ${STANDARDS.length} standards into ${target} (${memexId})`);

  // Pass 1: create every standard with a placeholder rule section, collecting
  // the allocated std-N handles.
  const handleByKey = new Map<string, string>();
  const sectionByKey = new Map<string, string>();
  for (const s of STANDARDS) {
    const created = await createStandard(memexId, {
      title: s.title,
      sections: [{ sectionType: "rule", title: "Rule", content: "" }],
    });
    handleByKey.set(s.key, created.handle);
    sectionByKey.set(s.key, created.sections[0].id);
    console.log(`  ${created.handle}  ${s.title}`);
  }

  // Pass 2: add the clauses with placeholders resolved to real handles — these
  // service writes fire syncClauseRefsTx, materializing the graph edges.
  for (const s of STANDARDS) {
    const bodies = s.clauses.map((c) =>
      c.replace(/\{(\w+)\}/g, (_, key: string) => {
        const h = handleByKey.get(key);
        if (!h) throw new Error(`Unknown placeholder {${key}} in ${s.key}`);
        return h;
      }),
    );
    await addClausesToSection(memexId, sectionByKey.get(s.key)!, bodies);
  }

  console.log("Done — open /standards and flip to map view.");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
