// Embedding helpers specific to the extractor.
//
// The provider itself (OpenAI/Cohere client, dim, batch size) lives in the
// server package so both ingest-time (here) and query-time (MCP semantic_search
// tool) can share one definition. This file only holds extractor-specific
// glue: how to chunk a symbol into embeddable text, and how to batch-call the
// provider at ingest time.

import type { EmbeddingProvider } from "@memex/server/services/embedding-provider";

// Compose the text we embed for a given symbol. Name + kind + signature +
// docstring + full body (capped at 100 lines for pathological long functions).
// 100 lines captures the whole method for anything sanely written — including
// policy branches, tenant filters, KLA-strip logic, and similar mid-method
// concerns that a short window silently omits. The cap protects against
// 500+ line god-methods where adding more tokens dilutes the semantic
// signal without adding meaning.
export function chunkSymbolForEmbedding(input: {
  name: string;
  kind: string | null;
  signature: string | null;
  docstring: string | null;
  bodyPreview: string | null;
  filePath: string;
}): string {
  const parts: string[] = [];
  parts.push(`${input.kind ?? "symbol"} ${input.name}`);
  if (input.signature) parts.push(input.signature);
  if (input.docstring) parts.push(input.docstring);
  if (input.bodyPreview) parts.push(input.bodyPreview);
  parts.push(`(in ${input.filePath})`);
  return parts.join("\n");
}

// Extract the body of a function from the file content, capped at `maxLines`.
// Uses the 1-indexed line numbers the extractor records. Returns null if we
// can't locate the symbol (bad coordinates, tiny file). Default 100 lines
// covers whole methods for anything sane; functions shorter than 100 lines
// return their full body because this is a cap, not a minimum.
export function extractBodyPreview(
  fileContent: string,
  lineStart: number | null,
  lineEnd: number | null,
  maxLines = 100,
): string | null {
  if (lineStart == null) return null;
  const lines = fileContent.split("\n");
  const startIdx = Math.max(0, lineStart - 1);
  const endIdx = lineEnd != null
    ? Math.min(lineEnd, startIdx + maxLines)
    : Math.min(lines.length, startIdx + maxLines);
  if (startIdx >= lines.length) return null;
  return lines.slice(startIdx, endIdx).join("\n");
}

// Batch through the provider. Keeps ingest-time memory flat: we don't hold
// every embedding in RAM at once; caller gets them back in input order.
export async function embedBatched(
  provider: EmbeddingProvider,
  chunks: string[],
): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < chunks.length; i += provider.maxBatchSize) {
    const batch = chunks.slice(i, i + provider.maxBatchSize);
    const vectors = await provider.embed(batch, "document");
    out.push(...vectors);
  }
  return out;
}
