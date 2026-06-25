// sol-4 (spec-368, std-12): the shared formatting + phase-guidance helpers now
// live in the NEUTRAL module `../formatting/formatters.ts` so cross-boundary
// importers (agent/handlers/*, agent/context-builder.ts, services/*) depend on a
// neutral location rather than reaching into the `mcp/` component. This file is a
// thin barrel kept so the many `mcp/`-internal call sites (mcp/tools.ts,
// mcp/memex-search, codebase-formatters, …) keep importing `./formatters.js`
// unchanged — the re-export is byte-identical, no behaviour change.
export * from "../formatting/formatters.js";
