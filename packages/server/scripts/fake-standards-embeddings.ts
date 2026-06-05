// Local-dev utility (spec-179) — writes FAKE clustered embeddings into a
// local namespace's standard sections so the standards-map semantic-neighbors
// overlay has something to draw without an embedding provider key (the
// pipeline silently skips when no OPENAI_API_KEY / COHERE_API_KEY is set, so
// local docs have NULL embeddings and the toggle stays disabled).
//
// The vectors are deterministic (seeded PRNG) and clustered into four fake
// "themes" so the overlay shows a realistic spread of similarities
// (~0.55–0.95 within a cluster, ~0 across) rather than an all-to-all blob.
// The PAIRINGS ARE MEANINGLESS — use this to judge the overlay's rendering,
// never its sense.
//
// Rows are marked embedding_model='fake-local-dev' so they're distinguishable
// from real provider output. Clear them with:
//   UPDATE doc_sections SET embedding=NULL, embedding_model=NULL
//   WHERE embedding_model='fake-local-dev';
//
// Usage: pnpm --filter @memex/server exec tsx scripts/fake-standards-embeddings.ts
// (targets the `barrie` namespace below — adjust the slug for other local data)

import postgres from "postgres";

const sql = postgres(
  process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/memex",
);

const DIM = 1536;

// Deterministic PRNG so re-runs produce identical vectors.
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randUnit(rand: () => number): number[] {
  const v = Array.from({ length: DIM }, () => rand() * 2 - 1);
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

function addNoise(base: number[], eps: number, rand: () => number): number[] {
  const noise = randUnit(rand);
  const v = base.map((b, i) => b + eps * noise[i]);
  const norm = Math.hypot(...v);
  return v.map((x) => x / norm);
}

const rows = await sql<{ id: string; handle: string }[]>`
  SELECT s.id, d.handle
  FROM doc_sections s
  JOIN documents d ON d.id = s.doc_id
  JOIN memexes m ON m.id = d.memex_id
  JOIN namespaces n ON n.id = m.namespace_id
  WHERE n.slug = 'barrie' AND d.doc_type = 'standard' AND d.archived_at IS NULL
  ORDER BY d.handle`;

const rand = mulberry32(179);
// Four thematic clusters; vary the noise so similarities spread ~0.55–0.95
// instead of saturating at 1.0.
const bases = [randUnit(rand), randUnit(rand), randUnit(rand), randUnit(rand)];
const clusterOf = (i: number) => [0, 0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 1][i % 13];

for (let i = 0; i < rows.length; i++) {
  const eps = 0.35 + rand() * 0.55; // cos ≈ 0.95 … 0.55 within a cluster
  const vec = addNoise(bases[clusterOf(i)], eps, rand);
  const literal = `[${vec.map((x) => x.toFixed(6)).join(",")}]`;
  await sql`
    UPDATE doc_sections
    SET embedding = ${literal}::vector,
        embedding_model = 'fake-local-dev',
        embedding_updated_at = now()
    WHERE id = ${rows[i].id}`;
  console.log(`${rows[i].handle} → cluster ${clusterOf(i)} (eps ${eps.toFixed(2)})`);
}

await sql.end();
console.log(`done: ${rows.length} sections embedded (fake)`);
