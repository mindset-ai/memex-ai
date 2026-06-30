// spec-340 t-4 / dec-8 — guard: the LLM facet classifier engine
// (services/facet-classifier.ts) must NEVER be imported by a server request/write
// path. Memex has no server-side LLM-on-write architecture; the intelligence lives in
// the user's coding agent. The classifier engine is reachable ONLY from the local,
// operator-run backfill script (scripts/backfill-facet-tags.ts) and tests.
//
// The request path reads the facet VOCABULARY through services/facet-vocab.ts (no LLM),
// not through this engine — so banning the whole engine module from request-path dirs
// is airtight. Tags ac-39.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { tagAc } from "@memex-ai-ac/vitest";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-340";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const SRC = resolve(__dirname, "..");

// The request/write surfaces — anything reachable from an inbound HTTP/MCP call.
const REQUEST_PATH_DIRS = ["routes", "agent", "mcp", "middleware"] as const;

// Module specifiers that resolve to the classifier engine.
const BANNED = ["facet-classifier"];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("facet classifier is never on a request path (spec-340 t-4, dec-8)", () => {
  it("no file under routes/agent/mcp/middleware imports services/facet-classifier (ac-39)", () => {
    tagAc(AC(39));
    const offenders: string[] = [];
    for (const d of REQUEST_PATH_DIRS) {
      const dir = join(SRC, d);
      let files: string[];
      try {
        files = walk(dir);
      } catch {
        continue; // dir may not exist
      }
      for (const f of files) {
        // Skip the guard's own test files / anything under __regression__ within these
        // dirs (none today, but keep it honest).
        if (f.includes("__regression__")) continue;
        const src = readFileSync(f, "utf8");
        // Only inspect import/require statements that name the banned module.
        const importsBanned = BANNED.some((m) => {
          const re = new RegExp(`(import[^;]*from\\s*['\"][^'\"]*${m}[^'\"]*['\"])|(require\\(['\"][^'\"]*${m}[^'\"]*['\"]\\))`);
          return re.test(src);
        });
        if (importsBanned) offenders.push(relative(SRC, f));
      }
    }
    expect(offenders, `request-path files importing the LLM facet classifier:\n${offenders.join("\n")}`).toEqual([]);
  });
});
