// Chunked bulk insert to stay under postgres-js / Postgres wire-protocol
// parameter limits. One statement can carry at most 65535 bound parameters,
// so a row with N columns caps at 65535 / N rows per INSERT. Chunking at
// 1000 rows gives comfortable headroom: our widest codebase-intelligence
// table is `symbols` with 13 columns, so each chunk sends ≤13000 params —
// well under the cap.
//
// Callers stay inside the same transaction; each chunk is an atomic INSERT
// but the overall ingestion remains all-or-nothing because chunks run in
// sequence and any failure rolls the whole tx back.
export const BULK_CHUNK_ROWS = 1000;

export async function bulkInsertChunks<Row extends object, Returned>(
  rows: Row[],
  insertChunk: (chunk: Row[]) => Promise<Returned[]>,
): Promise<Returned[]> {
  if (rows.length === 0) return [];
  const out: Returned[] = [];
  for (let i = 0; i < rows.length; i += BULK_CHUNK_ROWS) {
    const returned = await insertChunk(rows.slice(i, i + BULK_CHUNK_ROWS));
    out.push(...returned);
  }
  return out;
}
