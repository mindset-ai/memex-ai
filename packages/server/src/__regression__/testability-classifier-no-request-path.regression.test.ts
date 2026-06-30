// spec-151 t-6 / dec-6 (ac-18) — guard: the LLM testability classifier engine
// (services/testability-classifier.ts) must NEVER be imported by a server request/write
// path. Memex has no server-side LLM-on-write architecture (spec-340 dec-8); the
// intelligence lives in the user's coding agent. The engine is reachable ONLY from the
// local, operator-run backfill script (scripts/backfill-testability.ts) and tests.
//
// The request path persists an agent-SUPPLIED verdict through services/testability.ts (no
// LLM), NOT through this engine — so banning the engine module from request-path dirs is
// airtight. Mirrors facet-classifier-no-request-path.regression.test.ts. Tags ac-18.
//
// Note the ban string is the full `testability-classifier`, which does NOT match the
// request-path-safe `services/testability.js` — only the engine module is banned.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { tagAc } from "@memex-ai-ac/vitest";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-151";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

const __dirname = resolve(fileURLToPath(import.meta.url), "..");
const SRC = resolve(__dirname, "..");

// The request/write surfaces — anything reachable from an inbound HTTP/MCP call.
const REQUEST_PATH_DIRS = ["routes", "agent", "mcp", "middleware"] as const;

// Module specifiers that resolve to an LLM ENGINE (not a safe deterministic helper).
// dec-6: the testability classifier; dec-7: the adversarial clause-test verifier. Both
// use the metered Anthropic client and must be reachable only from operator/CI/agent
// paths + tests — never an inbound request path. The request path consults their
// deterministic siblings (services/testability.ts, services/clause-verification.ts).
const BANNED = ["testability-classifier", "clause-test-verifier"];

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

describe("testability classifier is never on a request path (spec-151 dec-6)", () => {
  it("no file under routes/agent/mcp/middleware imports services/testability-classifier (ac-18)", () => {
    tagAc(AC(18));
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
        // The ban is on PRODUCTION request-path code. Test files are explicitly allowed to
        // import the engine (dec-6: "reachable only from the backfill script and tests"),
        // so skip any *.test.* file and the test-only dirs.
        if (/\.test\.tsx?$/.test(f) || f.includes("__regression__") || f.includes("__test__") || f.includes("__e2e__")) {
          continue;
        }
        const src = readFileSync(f, "utf8");
        const importsBanned = BANNED.some((m) => {
          const re = new RegExp(
            `(import[^;]*from\\s*['\"][^'\"]*${m}[^'\"]*['\"])|(require\\(['\"][^'\"]*${m}[^'\"]*['\"]\\))`,
          );
          return re.test(src);
        });
        if (importsBanned) offenders.push(relative(SRC, f));
      }
    }
    expect(
      offenders,
      `request-path files importing the LLM testability classifier:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
