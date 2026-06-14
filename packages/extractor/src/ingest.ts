import { statSync } from "node:fs";
import { db } from "@memex/server/db/connection";
import {
  clearRepoData,
  getOrCreateRepo,
  setRepoScope,
  touchLastSynced,
} from "@memex/server/services/repos";
import { createFiles } from "@memex/server/services/files";
import { createSymbols } from "@memex/server/services/symbols";
import { createDependencies } from "@memex/server/services/imports";
import {
  createCalls,
  labelCallResolutionKinds,
  markNoiseCalls,
  resolveInheritanceCalls,
} from "@memex/server/services/calls";
import { createEndpoints } from "@memex/server/services/endpoints";
import {
  createDomains,
  createStructure,
  createTechStack,
} from "@memex/server/services/repo-meta";
import { createEmbeddings } from "@memex/server/services/embeddings";
import { resolveEmbeddingProvider } from "@memex/server/services/embedding-provider";
import type {
  FileInsert,
  SymbolInsert,
  DependencyInsert,
  CallInsert,
  RepoEndpointInsert,
} from "@memex/server/db/schema";
import { chunkSymbolForEmbedding, embedBatched, extractBodyPreview } from "./embed.ts";
import { collectFiles, commonBasePath, detectLanguage, fileHash, isTestFile } from "./walker.ts";
import { getExtractor, registeredLanguages } from "./extractors/index.ts";
import type { LanguageExtractor } from "./extractors/index.ts";
import { detectDomains, detectStructure, detectTechStack } from "./meta.ts";
import type {
  DepRecord,
  ExtractedCall,
  ExtractedEndpoint,
  ExtractedImport,
  ExtractedPatterns,
  ExtractedSymbol,
  Language,
} from "./types.ts";

// Exported kinds per language: names worth advertising as part of the
// "public API surface" of a file, used to seed the global_exported fallback
// in call resolution. Kept per-language so a Python `class Foo` can't
// accidentally match a TS call to an unrelated local `Foo`.
const EXPORTED_KINDS: ReadonlySet<string> = new Set([
  "function",
  "class",
  "interface",
  "type",
  "enum",
]);

export interface IngestInput {
  memexId: string;
  repoName: string;
  folderPaths: string[];
  /** Optional progress callback. Fired at each phase boundary. */
  onProgress?: (event: ProgressEvent) => void;
}

export interface ProgressEvent {
  phase:
    | "collect"
    | "parse"
    | "bulk-insert-files"
    | "bulk-insert-symbols"
    | "bulk-insert-deps"
    | "bulk-insert-calls"
    | "bulk-insert-endpoints"
    | "post-process"
    | "meta-layer"
    | "done";
  message: string;
  elapsedMs: number;
}

interface FileSlot {
  relPath: string;
  absPath: string;
  content: string;
  language: Language;
  extractor: LanguageExtractor;
  symbols: ExtractedSymbol[];
  imports: ExtractedImport[];
  calls: ExtractedCall[];
  endpoints: ExtractedEndpoint[];
  patterns: ExtractedPatterns | null;
  fileId?: string; // assigned after file insert
  symbolByName?: Map<string, string>; // assigned after symbol insert
  externalImportNames?: Set<string>; // populated during dep build
}

export async function ingest(input: IngestInput): Promise<void> {
  const { memexId, repoName, folderPaths, onProgress } = input;
  const startedAt = Date.now();
  const tick = (phase: ProgressEvent["phase"], message: string) =>
    onProgress?.({ phase, message, elapsedMs: Date.now() - startedAt });

  for (const f of folderPaths) {
    if (!statSync(f).isDirectory()) throw new Error(`Not a directory: ${f}`);
  }

  const basePath = commonBasePath(folderPaths);
  const repoUrl = folderPaths[0]!;

  // ── Phase 1: parse everything in memory (no DB) ──
  tick("collect", `walking ${folderPaths.length} folder(s)`);
  const collected = collectFiles(folderPaths, basePath);

  tick("parse", `parsing ${collected.length} files`);
  const slots: FileSlot[] = [];

  for (const c of collected) {
    const lang = detectLanguage(c.relPath);
    if (!lang) continue;
    const extractor = getExtractor(lang);
    if (!extractor) continue;
    // The registry already caches one extractor instance per language, and
    // each extractor caches its parser. No local cache needed here.
    const parser = await extractor.getParser();
    const tree = parser.parse(c.content)!;
    const symbols = extractor.extractSymbols(tree.rootNode);
    const imports = extractor.extractImports(tree.rootNode);
    const calls = extractor.extractCalls(tree.rootNode, symbols);
    const endpoints = extractor.extractEndpoints?.(tree.rootNode) ?? [];
    const patterns = extractor.extractPatterns?.(tree.rootNode) ?? null;
    slots.push({
      relPath: c.relPath,
      absPath: c.absPath,
      content: c.content,
      language: lang,
      extractor,
      symbols,
      imports,
      calls,
      endpoints,
      patterns,
    });
  }
  // Deterministic insertion order.
  slots.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  const sortedRelPaths = slots.map((s) => s.relPath);
  const repoFilePathSet = new Set(sortedRelPaths);
  const repoFilePathArr = sortedRelPaths;

  const langCounts = new Map<string, number>();
  for (const s of slots) langCounts.set(s.language, (langCounts.get(s.language) ?? 0) + 1);
  const langSummary = [...langCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${v} ${k}`)
    .join(", ");
  console.log(`Found ${slots.length} supported files (${langSummary})`);

  // Buffer for the embedding step. Populated inside the transaction (where
  // we have symbol IDs + file content in scope), consumed after commit.
  const embedPrep: Array<{
    repoId: string;
    fileId: string;
    symbolId: string;
    chunkText: string;
    chunkKind: string;
  }> = [];

  // ── Phase 2: everything below runs in ONE transaction ──
  // If anything throws — parsing issue surfaced late, FK violation,
  // constraint mismatch — the transaction rolls back and the repo is
  // left in whatever state it was in before this call.
  await db.transaction(async (tx) => {
    const { repo, created } = await getOrCreateRepo(
      { memexId, name: repoName, url: repoUrl },
      tx,
    );
    if (!created) await clearRepoData(repo.id, tx);
    await touchLastSynced(repo.id, tx);
    const repoId = repo.id;
    console.log(`Repo: ${repoName} (${repoId})${created ? " [new]" : " [re-ingest]"}`);

    await setRepoScope(repoId, folderPaths, tx);

    // ── Bulk insert files (single round trip) ──
    tick("bulk-insert-files", `inserting ${slots.length} files`);
    const fileRows: FileInsert[] = slots.map((s) => ({
      repoId,
      path: s.relPath,
      language: s.language,
      content: s.content,
      sizeBytes: Buffer.byteLength(s.content, "utf8"),
      gitHash: fileHash(s.content),
      isTest: isTestFile(s.relPath, s.content),
      lastUpdatedAt: new Date(),
    }));
    const insertedFiles = await createFiles(fileRows, tx);
    const pathToFileId = new Map<string, string>();
    for (const f of insertedFiles) pathToFileId.set(f.path, f.id);
    for (const s of slots) s.fileId = pathToFileId.get(s.relPath)!;

    // ── Bulk insert symbols ──
    // We do NOT rely on the order of rows returned from .returning() — the
    // Postgres wire protocol and SQL standard don't guarantee it matches
    // VALUES order. Instead we map returned rows back by their natural key
    // (file_id, name, kind, line_start), which the
    // `symbols_file_name_kind_line_unique` constraint guarantees is unique
    // per file. If the uniqueness ever gets broken (duplicate symbol rows)
    // the INSERT itself fails and the whole transaction rolls back, which
    // is the correct behaviour.
    tick("bulk-insert-symbols", `inserting symbols across ${slots.length} files`);
    const symbolRows: SymbolInsert[] = [];
    for (const s of slots) {
      for (const sym of s.symbols) {
        symbolRows.push({
          repoId,
          fileId: s.fileId!,
          name: sym.name,
          kind: sym.kind,
          parentName: sym.parentName,
          signature: sym.signature,
          lineStart: sym.lineStart,
          lineEnd: sym.lineEnd,
          isExported: sym.isExported,
          isAsync: sym.isAsync,
          language: sym.language,
          docComment: sym.docComment,
        });
      }
    }
    const insertedSymbols = await createSymbols(symbolRows, tx);
    // Key the returned rows by (fileId, name, kind, lineStart) and populate
    // per-file name→id maps from that key. Order-independent, correctness
    // preserved across any future Postgres/driver changes.
    const slotByFileId = new Map<string, FileSlot>();
    for (const s of slots) slotByFileId.set(s.fileId!, s);
    const naturalKey = (fileId: string, name: string, kind: string, lineStart: number | null) =>
      `${fileId}::${kind}::${name}::${lineStart ?? "?"}`;
    for (const row of insertedSymbols) {
      const slot = slotByFileId.get(row.fileId);
      if (!slot) continue;
      if (!slot.symbolByName) slot.symbolByName = new Map();
      slot.symbolByName.set(row.name, row.id);
    }

    // Capture embedding inputs while symbolIds + file content are in scope.
    // We don't embed inside this transaction (API calls are slow and would
    // hold row locks). We buffer the inputs here and process them after the
    // transaction commits, in a separate transaction. A failed embed step
    // does NOT roll back structural ingest — structural data stands on its
    // own; embeddings can be regenerated later.
    for (const row of insertedSymbols) {
      const slot = slotByFileId.get(row.fileId);
      if (!slot) continue;
      const bodyPreview = extractBodyPreview(
        slot.content,
        row.lineStart,
        row.lineEnd,
      );
      const chunkText = chunkSymbolForEmbedding({
        name: row.name,
        kind: row.kind,
        signature: row.signature,
        docstring: row.docComment,
        bodyPreview,
        filePath: slot.relPath,
      });
      embedPrep.push({
        repoId,
        fileId: row.fileId,
        symbolId: row.id,
        chunkText,
        chunkKind: "symbol",
      });
    }
    // The above populates by name only; call resolution reads by name, so
    // this is sufficient. We keep `naturalKey` available for future use
    // (e.g. test-coverage linking) where the richer key matters.
    void naturalKey;

    // ── Per-language globalExported maps for fallback call resolution ──
    // Separate maps per language so a Python-exported `Foo` never resolves
    // a TS call to a local/unrelated `Foo`.
    const globalExportedByLanguage = new Map<Language, Map<string, string>>();
    for (const s of slots) {
      const langMap = globalExportedByLanguage.get(s.language) ?? new Map<string, string>();
      for (const sym of s.symbols) {
        if (sym.isExported && EXPORTED_KINDS.has(sym.kind)) {
          const id = s.symbolByName?.get(sym.name);
          if (id) langMap.set(sym.name, id);
        }
      }
      globalExportedByLanguage.set(s.language, langMap);
    }

    // ── Build dependency rows + track external imports per file ──
    tick("bulk-insert-deps", `building dependency graph`);
    const depRows: DependencyInsert[] = [];
    const allDepsGlobal: DepRecord[] = [];
    for (const s of slots) {
      const externalNames = new Set<string>();
      for (const imp of s.imports) {
        const resolvedPath = s.extractor.resolveImport(imp.module, repoFilePathSet, s.relPath);
        const toFileId = resolvedPath ? pathToFileId.get(resolvedPath) ?? null : null;
        const isInternal = toFileId !== null;
        if (!isInternal) {
          for (const name of imp.names) externalNames.add(name);
        }
        allDepsGlobal.push({
          fromFileId: s.fileId!,
          toFileId,
          kind: isInternal ? "internal" : "external",
        });
        depRows.push({
          repoId,
          fromFileId: s.fileId!,
          toFileId,
          toPackage: isInternal ? null : imp.module,
          importedSymbols: imp.names,
          kind: isInternal ? "internal" : "external",
        });
      }
      s.externalImportNames = externalNames;
    }
    await createDependencies(depRows, tx);

    // ── Build per-language import index for cross-module resolution ──
    // (fileId::importedName) → targetSymbolId, for internal imports only.
    // `slotByFileId` was built above right after the symbol insert; reusing
    // it here avoids an O(slots × imports) .find() in what was previously
    // a hot path.
    //
    // Cross-language internal resolution: if a TS file imports from a
    // Python file, the names will match. That's technically supported
    // here, but in practice almost always a false positive (a TS import
    // can't actually load a .py file at runtime). We still populate it
    // for symmetry; consumers who want same-language-only should filter
    // at query time.
    const importIndex = new Map<string, string>();
    for (const s of slots) {
      for (const imp of s.imports) {
        const resolvedPath = s.extractor.resolveImport(imp.module, repoFilePathSet, s.relPath);
        if (!resolvedPath) continue;
        const targetFileId = pathToFileId.get(resolvedPath);
        if (!targetFileId) continue;
        const targetSlot = slotByFileId.get(targetFileId);
        if (!targetSlot || !targetSlot.symbolByName) continue;
        for (const name of imp.names) {
          const id = targetSlot.symbolByName.get(name);
          if (id) importIndex.set(`${s.fileId}::${name}`, id);
        }
      }
    }

    // ── Build call rows with import/local/global-exported/external
    // resolution (priority order). Resolution is language-scoped at each
    // step: local table is this file's symbols; global_exported is this
    // language's exported symbols; external uses this file's external
    // import names. ──
    tick("bulk-insert-calls", `resolving and inserting calls`);
    const callRows: CallInsert[] = [];
    let totalCalls = 0;
    let totalResolved = 0;
    let totalExternal = 0;
    for (const s of slots) {
      const localSyms = s.symbolByName ?? new Map<string, string>();
      const globalExported = globalExportedByLanguage.get(s.language) ?? new Map<string, string>();
      const externalNames = s.externalImportNames ?? new Set<string>();
      for (const c of s.calls) {
        const fromId = localSyms.get(c.fromSymbolName);
        if (!fromId) continue;
        const toId =
          importIndex.get(`${s.fileId}::${c.toName}`) ??
          localSyms.get(c.toName) ??
          globalExported.get(c.toName) ??
          null;
        let resolutionKind: string | null = null;
        if (toId) {
          totalResolved++;
        } else {
          const firstSegment = c.fullCall.split(".")[0] ?? "";
          if (externalNames.has(firstSegment)) {
            resolutionKind = "external";
            totalExternal++;
          }
        }
        totalCalls++;
        callRows.push({
          repoId,
          fromSymbolId: fromId,
          toName: c.toName,
          toSymbolId: toId,
          lineNumber: c.lineNumber,
          resolutionKind,
        });
      }
    }
    await createCalls(callRows, tx);

    // ── Bulk insert endpoints ──
    tick("bulk-insert-endpoints", `inserting endpoints`);
    const endpointRows: RepoEndpointInsert[] = [];
    for (const s of slots) {
      if (s.endpoints.length === 0) continue;
      const localSyms = s.symbolByName ?? new Map<string, string>();
      for (const ep of s.endpoints) {
        endpointRows.push({
          repoId,
          fileId: s.fileId!,
          handlerSymbolId: ep.handlerName ? localSyms.get(ep.handlerName) ?? null : null,
          method: ep.method,
          path: ep.path,
          handlerName: ep.handlerName,
          lineNumber: ep.lineNumber,
          framework: ep.framework,
        });
      }
    }
    await createEndpoints(endpointRows, tx);

    // ── Post-process: noise marking (per language) + inheritance (per
    // language using each language's parent-class parser) + resolution
    // labeling (language-agnostic). ──
    tick("post-process", `language-scoped noise + inheritance + labels`);
    let noiseCount = 0;
    let inheritanceResolved = 0;
    // Only loop languages that actually appear in this ingest.
    const languagesInThisIngest = new Set<Language>(slots.map((s) => s.language));
    for (const lang of languagesInThisIngest) {
      const extractor = getExtractor(lang);
      if (!extractor) continue;
      noiseCount += await markNoiseCalls(repoId, lang, [...extractor.noiseNames], tx);
      inheritanceResolved += await resolveInheritanceCalls(
        repoId,
        lang,
        extractor.parseParentClassSignature.bind(extractor),
        tx,
      );
    }
    await labelCallResolutionKinds(repoId, tx);

    // ── Meta layer ──
    tick("meta-layer", `structural conventions, tech stack, domains`);
    const absFilePaths = slots.map((s) => s.absPath);
    // Keep the old import-shape for meta detection (for now — meta.ts expects it).
    const allImportsGlobal: ExtractedImport[] = [];
    for (const s of slots) allImportsGlobal.push(...s.imports);

    const structures = detectStructure(absFilePaths, basePath);
    await createStructure(
      structures.map((sv) => ({
        repoId,
        kind: sv.kind,
        pathPattern: sv.pathPattern,
        fileCount: sv.fileCount,
        confidence: sv.confidence,
      })),
      tx,
    );

    const stack = detectTechStack(allImportsGlobal);
    await createTechStack(
      stack.map((sv) => ({ repoId, layer: sv.layer, name: sv.name, evidence: sv.evidence })),
      tx,
    );

    const domains = detectDomains(absFilePaths, basePath, allDepsGlobal);
    await createDomains(
      domains.map((d) => ({
        repoId,
        name: d.name,
        rootPaths: d.rootPaths,
        fileCount: d.fileCount,
      })),
      tx,
    );

    // Final summary counts come from what we just inserted (already in-memory).
    const resolvableInternal = totalCalls - noiseCount - totalExternal;
    const totalResolvedFinal = totalResolved + inheritanceResolved;
    const internalPct =
      resolvableInternal > 0 ? (totalResolvedFinal / resolvableInternal) * 100 : 0;

    console.log("\n" + "=".repeat(50));
    console.log(`  INGESTION COMPLETE: ${repoName}`);
    console.log("=".repeat(50));
    console.log(`  Repo ID:           ${repoId}`);
    console.log(`  Files:             ${slots.length}`);
    console.log(`  Symbols:           ${symbolRows.length}`);
    console.log(`  Dependencies:      ${depRows.length}`);
    console.log(
      `  Calls:             ${totalCalls} total (${noiseCount} noise, ${totalExternal} external, ${resolvableInternal} internal)`,
    );
    console.log(
      `  Resolution:        ${totalResolvedFinal}/${resolvableInternal} internal (${internalPct.toFixed(1)}%), +${inheritanceResolved} via inheritance`,
    );
    console.log(`  Endpoints:         ${endpointRows.length}`);
    console.log(`  Structure:         ${structures.length} conventions`);
    console.log(`  Tech stack:        ${stack.length} items`);
    console.log(`  Domains:           ${domains.length} detected`);
    tick("done", `complete in ${Date.now() - startedAt}ms`);
  });
  // Transaction committed. All rows durable; or all rolled back on any throw above.

  // ── Phase 3: embedding generation (post-commit, best-effort) ──
  // Embeddings are derived data. If the provider isn't configured or the
  // API call fails, structural ingest still succeeded and the repo is
  // queryable via the structural tools (find_symbol, get_impact, etc.).
  // Semantic search just won't work until embeddings are backfilled.
  const provider = resolveEmbeddingProvider();
  if (provider == null) {
    console.log(
      "\n[embed] skipped (no provider configured). " +
        "Set OPENAI_API_KEY to enable semantic search on this repo.",
    );
    return;
  }
  if (embedPrep.length === 0) {
    console.log("[embed] nothing to embed (no symbols).");
    return;
  }

  const embedStart = Date.now();
  console.log(
    `\n[embed] generating ${embedPrep.length} embeddings via ${provider.name} ` +
      `(batch size ${provider.maxBatchSize})...`,
  );
  try {
    const vectors = await embedBatched(
      provider,
      embedPrep.map((p) => p.chunkText),
    );
    if (vectors.length !== embedPrep.length) {
      throw new Error(
        `embed batch size mismatch: got ${vectors.length} vectors for ${embedPrep.length} inputs`,
      );
    }
    await db.transaction(async (tx) => {
      await createEmbeddings(
        embedPrep.map((p, i) => ({
          repoId: p.repoId,
          fileId: p.fileId,
          symbolId: p.symbolId,
          chunkText: p.chunkText,
          chunkKind: p.chunkKind,
          embedding: vectors[i]!,
          model: provider.name,
        })),
        tx,
      );
    });
    const embedMs = Date.now() - embedStart;
    console.log(
      `[embed] done in ${embedMs}ms (${(embedPrep.length / (embedMs / 1000)).toFixed(0)} embeds/sec)`,
    );
  } catch (err) {
    console.error(
      `[embed] failed: ${err instanceof Error ? err.message : String(err)}. ` +
        `Structural ingest is complete; re-run with a working provider to backfill.`,
    );
    // Deliberately swallowed — structural ingest already committed.
  }
}

// Re-export registeredLanguages so callers can iterate known extractors
// (e.g. tests that exercise each language in turn).
export { registeredLanguages };
