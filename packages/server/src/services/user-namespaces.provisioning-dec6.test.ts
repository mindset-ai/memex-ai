// spec-474 dec-6 — account-readiness provisioning runs on the first-load readiness
// endpoint (provisionUserMemex / POST /api/me/provision), NOT on the signup request.
//
// The reported bug: the onboarding seed (starter Spec + default Standards + facets) was
// awaited inside ensureUserNamespace on the signup request, delaying the signup response
// and the verification email. It couldn't simply be detached (Cloud Run throttles CPU to
// ~0 after the response flushes → empty Memexes). dec-6 moves the seed onto a DIFFERENT
// request (the readiness endpoint), which has its own CPU allocation.
//
// This suite asserts the new contract against REAL Postgres:
//   ac-20 — ensureUserNamespace creates the Memex but seeds NO content (signup doesn't wait).
//   ac-21 — provisionUserMemex seeds the content + stamps provisioned_at, idempotently.
//   ac-22 — getPersonalMemexProvisionState reports readiness (the signal the SPA reads).
//
// ── spec-509: this suite is now ALSO the no-content-seed guard ─────────────────
// spec-509 dec-2 deleted the starter-Spec seeder, so "the content" provisioning seeds is
// facets + Standards and NOTHING ELSE. The ac-21 test below therefore asserts a ZERO spec
// count where it used to assert exactly one starter Spec (spec-509 ac-13), while still
// asserting the Standards ARE seeded (ac-15) — the positive control that distinguishes
// "correctly seeded no Spec" from "provisioning silently failed".
//
// The guard is UNCONDITIONAL by construction: dec-2 removed the seeder rather than gating
// it behind MEMEX_HANDHOLD_SIGNUP_SEED, so this cannot pass merely because an env var
// happens to be set in the test environment. That is exactly why the flag was rejected.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tagAc } from "@memex-ai-ac/vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/connection.js";
import { namespaces, users, documents, memexes } from "../db/schema.js";
import {
  ensureUserNamespace,
  provisionUserMemex,
  getPersonalMemexProvisionState,
} from "./user-namespaces.js";
import { upsertUserByEmail } from "./users.js";
import { DEFAULT_STANDARDS_COUNT } from "../db/default-standards.fixture.js";

const AC474 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-474/acs/ac-${n}`;
const AC_SIGNUP_NONBLOCK = AC474(20);
const AC_READINESS_ENDPOINT = AC474(21);
const AC_READINESS_SIGNAL = AC474(22);
const AC509 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-509/acs/ac-${n}`;

const createdNamespaceIds: string[] = [];
const createdUserIds: string[] = [];

beforeAll(() => {
  // spec-186: the vitest config disables the signup-seed hooks suite-wide; this suite
  // verifies provisioning fires, so opt back in (read at CALL time). spec-509 dec-2
  // removed MEMEX_HANDHOLD_SIGNUP_SEED entirely along with the seeder it gated, so the
  // Standards seed is the only hook left to opt in.
  process.env.MEMEX_DEFAULT_STANDARDS_SIGNUP_SEED = "on";
});
afterAll(() => {
  process.env.MEMEX_DEFAULT_STANDARDS_SIGNUP_SEED = "off";
});
afterAll(async () => {
  if (createdNamespaceIds.length) {
    await db.delete(namespaces).where(inArray(namespaces.id, createdNamespaceIds)).catch(() => {});
  }
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds)).catch(() => {});
  }
});

async function newUser(): Promise<{ id: string }> {
  const user = await upsertUserByEmail(
    `dec6-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
  );
  createdUserIds.push(user.id);
  return user;
}

async function trackNamespace(userId: string): Promise<void> {
  const [ns] = await db
    .select({ id: namespaces.id })
    .from(namespaces)
    .where(and(eq(namespaces.ownerUserId, userId), eq(namespaces.kind, "user")))
    .limit(1);
  if (ns) createdNamespaceIds.push(ns.id);
}

type DocRow = {
  docType: string;
  title: string;
  createdByUserId: string | null;
  isDemo: boolean;
  status: string;
};

/** Every Spec in the memex, regardless of title or attribution. spec-509 ac-13 is a
 *  count-of-ZERO commitment, so the guard must NOT filter by the retired title — a seeder
 *  reintroduced under a different name has to trip it too. */
function specDocs(docs: DocRow[]) {
  return docs.filter((d) => d.docType === "spec");
}

async function docsIn(memexId: string): Promise<DocRow[]> {
  return db
    .select({
      docType: documents.docType,
      title: documents.title,
      createdByUserId: documents.createdByUserId,
      isDemo: documents.isDemo,
      status: documents.status,
    })
    .from(documents)
    .where(eq(documents.memexId, memexId));
}

describe("spec-474 dec-6 — provisioning is off the signup path, on the readiness endpoint", () => {
  it("ensureUserNamespace creates the Memex but seeds NO content — signup never waits on the seed (ac-20)", async () => {
    tagAc(AC_SIGNUP_NONBLOCK);
    tagAc(AC474(8)); // scope: signup returns without blocking on content provisioning
    const user = await newUser();
    const created = await ensureUserNamespace(user.id);
    await trackNamespace(user.id);

    const docs = await docsIn(created.memex.id);
    expect(specDocs(docs)).toHaveLength(0);
    expect(docs.filter((d) => d.docType === "standard")).toHaveLength(0);

    const state = await getPersonalMemexProvisionState(user.id);
    expect(state.provisioned).toBe(false);
    expect(state.memexId).toBe(created.memex.id);
  });

  it("provisionUserMemex seeds all Standards and NO Spec, and stamps provisioned_at, idempotently (ac-21 / spec-509 ac-13 + ac-15)", async () => {
    tagAc(AC_READINESS_ENDPOINT);
    // spec-509 ac-13: the no-content-seed guard. Zero Specs in a freshly provisioned
    // personal Memex — the whole point of dec-2.
    tagAc(AC509(13));
    // spec-509 ac-15: the positive control. Standards + facets are still seeded inside
    // runWithMemexId, so a zero spec count means "seeded nothing" and NOT "provisioning
    // failed" — without this, a total seed failure and a correct removal look identical.
    tagAc(AC509(15));
    const user = await newUser();
    const created = await ensureUserNamespace(user.id);
    await trackNamespace(user.id);
    const memexId = created.memex.id;

    const first = await provisionUserMemex(user.id);
    expect(first.seeded).toBe(true);
    expect(first.memexId).toBe(memexId);

    const docs = await docsIn(memexId);
    // ac-13: NO Spec of any kind is seeded — not the retired starter, not a replacement.
    expect(specDocs(docs)).toHaveLength(0);
    // ac-15: the Standards DID land. This is what makes the zero above trustworthy.
    expect(docs.filter((d) => d.docType === "standard")).toHaveLength(DEFAULT_STANDARDS_COUNT);
    // No demo walkthrough content either (spec-474 ac-1, still true).
    expect(docs.filter((d) => d.isDemo === true)).toHaveLength(0);

    const [m] = await db
      .select({ provisionedAt: memexes.provisionedAt })
      .from(memexes)
      .where(eq(memexes.id, memexId))
      .limit(1);
    expect(m?.provisionedAt).not.toBeNull();

    // Idempotent: a second call seeds nothing and does not duplicate.
    const second = await provisionUserMemex(user.id);
    expect(second.seeded).toBe(false);
    const docs2 = await docsIn(memexId);
    expect(specDocs(docs2)).toHaveLength(0);
    expect(docs2.filter((d) => d.docType === "standard")).toHaveLength(DEFAULT_STANDARDS_COUNT);
  });

  it("getPersonalMemexProvisionState flips from not-ready to ready across provisioning (ac-22)", async () => {
    tagAc(AC_READINESS_SIGNAL);
    const user = await newUser();
    await ensureUserNamespace(user.id);
    await trackNamespace(user.id);

    expect((await getPersonalMemexProvisionState(user.id)).provisioned).toBe(false);
    await provisionUserMemex(user.id);
    expect((await getPersonalMemexProvisionState(user.id)).provisioned).toBe(true);
  });
});
