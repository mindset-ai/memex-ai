// spec-510 t-11 (dec-8, ac-20) — the guard on GuidanceBlock ids.
//
// The cadence this Spec builds keys its per-session seen-set on `block:{id}`
// (dec-7, t-1). That key has no substrate unless every base block carries a
// stable id, so this guard is what makes t-1 buildable rather than a promise.
//
// UNIQUENESS is the load-bearing half, and its failure is SILENT: two blocks
// sharing an id share one suppression state, so showing the first would
// suppress the second for the rest of the session. No error, no red test
// anywhere else, just an agent quietly missing guidance it was never shown.
// That is why this is a build-failing guard and not a lint.
//
// Why ids must be human-readable: the id lands in the claim key, so a
// suppression bug is diagnosed by reading `block:tripwire-protocol-build` out
// of a database row. Opaque ids would mean debugging that blind.
//
// Why ids must be STABLE: they are persisted in live sessions' claim keys.
// Renaming one orphans the suppression state of every session that has seen
// it. Treat an id like a database key, not a label — the same reason dec-8
// rejected content hashing (t-6 deliberately edits block text).
import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { BASE_SCAFFOLD } from './scaffold-data.js';

const AC_20 = 'mindset-prod/memex-building-itself/specs/spec-510/acs/ac-20';

/** Human-readable claim-key segment: lowercase kebab, no leading/trailing dash. */
const ID_SHAPE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A block's position + text prefix, so a failure names the offender in the file. */
function describeBlock(index: number, text: string): string {
  return `baseGuidance[${index}] ${JSON.stringify(text.slice(0, 60))}`;
}

describe('spec-510 t-11 — base GuidanceBlock ids (ac-20)', () => {
  it('gives every base block a non-empty id', () => {
    tagAc(AC_20);
    const missing = BASE_SCAFFOLD.baseGuidance
      .map((block, index) => ({ block, index }))
      .filter(({ block }) => typeof block.id !== 'string' || block.id.trim() === '')
      .map(({ block, index }) => describeBlock(index, block.text));

    expect(
      missing,
      `Every base GuidanceBlock needs an explicit id — it is the substrate for the ` +
        `cadence claim key (dec-8). Blocks without one:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('keeps base block ids unique — a duplicate silently merges two suppression states', () => {
    tagAc(AC_20);
    const seen = new Map<string, number[]>();
    BASE_SCAFFOLD.baseGuidance.forEach((block, index) => {
      const id = block.id;
      if (typeof id !== 'string' || id === '') return; // the other test owns that failure
      const at = seen.get(id);
      if (at) at.push(index);
      else seen.set(id, [index]);
    });

    const duplicates = [...seen.entries()]
      .filter(([, indices]) => indices.length > 1)
      .map(([id, indices]) => `${id} → baseGuidance[${indices.join(', ')}]`);

    expect(
      duplicates,
      `Duplicate base block ids. Two blocks sharing an id share ONE suppression ` +
        `state: showing either would suppress the other for the whole session, ` +
        `with no error anywhere. Give each its own id:\n  ${duplicates.join('\n  ')}`,
    ).toEqual([]);
  });

  it('keeps ids human-readable, because the id is what a suppression bug is read by', () => {
    tagAc(AC_20);
    const malformed = BASE_SCAFFOLD.baseGuidance
      .map((block, index) => ({ block, index }))
      .filter(({ block }) => typeof block.id === 'string' && !ID_SHAPE.test(block.id))
      .map(({ block, index }) => `${block.id} (${describeBlock(index, block.text)})`);

    expect(
      malformed,
      `Base block ids must be lowercase kebab-case — they are read out of claim ` +
        `keys in the database when diagnosing suppression:\n  ${malformed.join('\n  ')}`,
    ).toEqual([]);
  });

  it('proves `order` could not have served as the key — it is not unique', () => {
    tagAc(AC_20);
    // dec-8 rejected `order` as an identifier. This pins the reason in a test so
    // a later reader does not re-propose it: the four tripwire blocks all carry
    // order 30, so an order-keyed claim would collapse them into one.
    const orders = BASE_SCAFFOLD.baseGuidance.map((block) => block.order);
    expect(new Set(orders).size).toBeLessThan(orders.length);
  });
});
