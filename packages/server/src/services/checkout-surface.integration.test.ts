import { describe, it, expect } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { db } from "../db/connection.js";
import { documents } from "../db/schema.js";
import { makeTestMemex } from "./test-helpers.js";
import { upsertUserByEmail } from "./users.js";
import { stampCheckout } from "./checkout.js";
import { getDoc } from "./documents.js";
import { formatFullDocState } from "../formatting/formatters.js";

// spec-371: who currently holds a spec's checkout (+ how long ago) is SURFACED in
// the get_doc output (ac-6) — the read affordance that makes the checkout visible.
const AC_6 = "mindset-prod/memex-building-itself/specs/spec-371/acs/ac-6";

async function makeSpec(memexId: string): Promise<string> {
  const [doc] = await db
    .insert(documents)
    .values({ memexId, handle: "spec-1", title: "Surface Spec", docType: "spec" })
    .returning({ id: documents.id });
  return doc.id;
}

const render = async (memexId: string, docId: string) =>
  formatFullDocState(await getDoc(memexId, docId), [], []);

describe("get_doc surfaces the checkout holder (spec-371 ac-6)", () => {
  it("a free spec shows NO 'Checked out by' line", async () => {
    tagAc(AC_6);
    const memexId = await makeTestMemex("cs");
    const docId = await makeSpec(memexId);
    expect(await render(memexId, docId)).not.toMatch(/Checked out by/);
  });

  it("a held spec shows 'Checked out by: <holder> (N minutes ago)'", async () => {
    tagAc(AC_6);
    const memexId = await makeTestMemex("cs");
    const holder = await upsertUserByEmail("holder@example.com");
    const docId = await makeSpec(memexId);

    // just now → "less than a minute ago"
    await stampCheckout({ docId, userId: holder.id, thread: "conv-1" });
    expect(await render(memexId, docId)).toMatch(
      /Checked out by: holder@example\.com \(less than a minute ago\)/,
    );

    // 8 minutes ago → the minutes count is surfaced
    await stampCheckout({
      docId,
      userId: holder.id,
      thread: "conv-1",
      now: new Date(Date.now() - 8 * 60_000),
    });
    expect(await render(memexId, docId)).toMatch(
      /Checked out by: holder@example\.com \(8 minutes ago\)/,
    );
  });
});
