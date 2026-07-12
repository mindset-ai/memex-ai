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
import { STARTER_SPEC_TITLE } from "../db/starter-spec.fixture.js";

const AC474 = (n: number) => `mindset-prod/memex-building-itself/specs/spec-474/acs/ac-${n}`;
const AC_SIGNUP_NONBLOCK = AC474(20);
const AC_READINESS_ENDPOINT = AC474(21);
const AC_READINESS_SIGNAL = AC474(22);

const createdNamespaceIds: string[] = [];
const createdUserIds: string[] = [];

beforeAll(() => {
  // spec-186: the vitest config disables the signup-seed hooks suite-wide; this suite
  // verifies provisioning fires, so opt back in (read at CALL time).
  process.env.MEMEX_HANDHOLD_SIGNUP_SEED = "on";
  process.env.MEMEX_DEFAULT_STANDARDS_SIGNUP_SEED = "on";
});
afterAll(() => {
  process.env.MEMEX_HANDHOLD_SIGNUP_SEED = "off";
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

function starterDocs(docs: DocRow[]) {
  return docs.filter(
    (d) => d.docType === "spec" && d.title === STARTER_SPEC_TITLE && d.createdByUserId === null,
  );
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
    expect(starterDocs(docs)).toHaveLength(0);
    expect(docs.filter((d) => d.docType === "standard")).toHaveLength(0);

    const state = await getPersonalMemexProvisionState(user.id);
    expect(state.provisioned).toBe(false);
    expect(state.memexId).toBe(created.memex.id);
  });

  it("provisionUserMemex seeds the starter Spec + all Standards and stamps provisioned_at, idempotently (ac-21)", async () => {
    tagAc(AC_READINESS_ENDPOINT);
    tagAc(AC474(1)); // scope: exactly one system-attributed starter spec, no demo, seeded directly
    tagAc(AC474(10)); // impl: provisioning seeds via a direct seedStarterSpec call (no experiment path)
    tagAc(AC474(12)); // impl: exactly one spec doc — title/attribution/is_demo/status shape
    const user = await newUser();
    const created = await ensureUserNamespace(user.id);
    await trackNamespace(user.id);
    const memexId = created.memex.id;

    const first = await provisionUserMemex(user.id);
    expect(first.seeded).toBe(true);
    expect(first.memexId).toBe(memexId);

    const docs = await docsIn(memexId);
    const starters = starterDocs(docs);
    expect(starters).toHaveLength(1);
    // ac-12: the one starter spec is system-attributed, non-demo, and lands in 'specify'.
    expect(starters[0].createdByUserId).toBeNull();
    expect(starters[0].isDemo).toBe(false);
    expect(starters[0].status).toBe("specify");
    // ac-1 / ac-12: no demo walkthrough content is ever seeded.
    expect(docs.filter((d) => d.isDemo === true)).toHaveLength(0);
    expect(docs.filter((d) => d.docType === "standard")).toHaveLength(DEFAULT_STANDARDS_COUNT);

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
    expect(starterDocs(docs2)).toHaveLength(1);
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
