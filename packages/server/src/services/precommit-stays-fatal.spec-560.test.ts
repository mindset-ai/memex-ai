// spec-560 t-1 (dec-2) — the boundary the non-fatality must NOT cross.
//
// spec-560 makes everything AFTER the commit non-fatal. The obvious next step, and the
// wrong one, is to make "ballot failures" non-fatal as a category. `requireBallotForMemex`
// runs BEFORE `createTask()` / `createDecision()`, and spec-499's contract depends on it
// staying loud: a rejected ballot must fail the call outright, so no orphan row is left
// and the caller is re-handed the vocabulary.
//
// So this pins the seam of the seam: validation throws, and `afterCommit` is nowhere on
// that path. Only `vocabForMemex` is stubbed (it is the sole DB read); the validator
// under test is the real one.

import { describe, it, expect, vi } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SPEC = "mindset-prod/memex-building-itself/specs/spec-560";
const AC = (n: number) => `${SPEC}/acs/ac-${n}`;

const vocabForMemex = vi.hoisted(() => vi.fn());
vi.mock("./facet-vocab.js", () => ({ vocabForMemex }));

const { requireBallotForMemex } = await import("./facet-ballot.js");
const { ValidationError } = await import("../types/errors.js");

const VOCAB = [
  { key: "architecture", label: "Architecture", description: "how components fit together" },
  { key: "security", label: "Security", description: "authz, tenancy, secrets" },
];

const OPTS = { noun: "task" as const, channel: "mcp" as const };

describe("spec-560: pre-commit validation stays fatal", () => {
  it("an ABSENT ballot still throws where a vocabulary exists — nothing is created", async () => {
    tagAc(AC(11));
    vocabForMemex.mockResolvedValue(VOCAB);

    await expect(
      requireBallotForMemex(
        "m-1",
        { provided: false, ballot: { verdict: {}, none: false } },
        OPTS,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("an INCOMPLETE ballot still throws — the caller is re-handed the vocabulary", async () => {
    tagAc(AC(11));
    vocabForMemex.mockResolvedValue(VOCAB);

    // 'security' omitted: a partial verdict is not a verdict.
    await expect(
      requireBallotForMemex(
        "m-1",
        { provided: true, ballot: { verdict: { architecture: true }, none: false } },
        OPTS,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("an empty-vocabulary Memex still needs no ballot — bare fixtures keep working", async () => {
    tagAc(AC(11));
    vocabForMemex.mockResolvedValue([]);

    await expect(
      requireBallotForMemex("m-1", { provided: false, ballot: { verdict: {}, none: false } }, OPTS),
    ).resolves.toEqual([]);
  });

  it("afterCommit is absent from the validation path — non-fatality begins after the write", () => {
    tagAc(AC(11));
    // Behavioural assertions above prove validation still throws TODAY. This one pins the
    // reason it cannot quietly stop throwing later: the moment `afterCommit` appears in
    // facet-ballot.ts, a rejected ballot becomes a warning and spec-499's contract is
    // gone with no test necessarily going red. The import list is the tripwire.
    const src = readFileSync(join(__dirname, "facet-ballot.ts"), "utf8");
    expect(src).not.toContain("after-commit");
    expect(src).not.toContain("afterCommit");
  });
});
