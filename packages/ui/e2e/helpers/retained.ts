// Additive HTTP-client seed/read helpers for the retained journeys (spec-172
// t-5). These are thin clients of the env-gated /api/__test__ surface, in the
// same shape as helpers/seed.ts — the retained journeys that used raw SQL (the
// pre-0038 db.ts / db-memex.ts / reactivity-fixtures.ts) re-base onto these so
// the e2e package keeps NO Postgres dependency [dec-2] and every seeded mutation
// emits on the bus [per std-8].
//
// The base-URL + error handling mirror seed.ts exactly.

// Default tracks E2E_SERVER_PORT so a port override moves the helpers with the
// server (overriding one without the other sent every request to a dead port).
const API_URL =
  process.env.E2E_API_URL ??
  `http://localhost:${process.env.E2E_SERVER_PORT ?? 8090}`;

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}/api/__test__${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`__test__ ${method} ${path} failed (${res.status}): ${text}`);
  }
  return (await res.json()) as T;
}

export interface SeededOrgTenant {
  orgId: string;
  namespaceSlug: string;
  memexSlug: string;
  memexId: string;
}

/**
 * Seed an org-owned namespace + memex with `ownerEmail` (default dev@memex.ai)
 * as an active administrator — the path-based tenant the journey navigates to
 * (`/<namespaceSlug>/<memexSlug>/...`). Backed by createOrgWithMemexForUser, so
 * the dev user opens the memex as a writing member. The caller tracks
 * `namespaceSlug` via `resources.slug(prefix)` for afterEach cleanup.
 */
export async function seedOrgTenant(opts: {
  slug: string;
  ownerEmail?: string;
  name?: string;
  memexSlug?: string;
}): Promise<SeededOrgTenant> {
  return call<SeededOrgTenant>("POST", "/seed-org", {
    ownerEmail: opts.ownerEmail ?? "dev@memex.ai",
    slug: opts.slug,
    name: opts.name,
    memexSlug: opts.memexSlug,
  });
}

/** Seed a spec into a memex; the service mints the handle. `sectionId` is the
 *  first (overview/purpose) section — handy for over-the-API section mutations. */
export async function seedSpec(opts: {
  memexId: string;
  title: string;
  purpose?: string;
  /** Attribute the spec to a creator — surfaces as the QA Reports author (spec-286). */
  createdByUserId?: string;
}): Promise<{ docId: string; handle: string; sectionId: string }> {
  return call("POST", "/seed-spec", opts);
}

/** spec-196: set a doc's status through the real updateDocStatus service —
 *  for phases the UI can't browse to (e.g. `done` for the read view). */
export async function setDocStatus(opts: {
  memexId: string;
  docId: string;
  status: string;
}): Promise<{ docId: string; status: string }> {
  return call("POST", "/set-doc-status", opts);
}

/** spec-196: stamp narrativeLastConsolidatedAt = now() through the real
 *  markNarrativeConsolidated service (assess_spec consolidate's effect). */
export async function consolidateNarrative(opts: {
  memexId: string;
  docId: string;
}): Promise<{ consolidatedAt: string }> {
  return call("POST", "/consolidate-narrative", opts);
}

/** Seed a standard / document (first section carries `body` for FTS). */
export async function seedDoc(opts: {
  memexId: string;
  title: string;
  body?: string;
  docType?: "standard" | "document";
}): Promise<{ docId: string; handle: string; sectionId: string }> {
  return call("POST", "/seed-doc", opts);
}

/** Convenience: seed a standard (a `rule` section carries `body`). */
export async function seedStandard(opts: {
  memexId: string;
  title: string;
  body?: string;
}): Promise<{ docId: string; handle: string; sectionId: string }> {
  return call("POST", "/seed-doc", { ...opts, docType: "standard" });
}

/** Build a path-based tenant API URL on the server origin:
 *  `${E2E_API_URL}/api/<ns>/<mx>/<suffix>` [per std-2]. */
export function tenantApiUrl(
  namespaceSlug: string,
  memexSlug: string,
  suffix: string
): string {
  const clean = suffix.replace(/^\//, "");
  return `${API_URL}/api/${namespaceSlug}/${memexSlug}/${clean}`;
}

/** Append a section to a doc through addSection (emits on the bus). */
export async function seedSection(opts: {
  memexId: string;
  docId: string;
  title: string;
  content?: string;
  sectionType?: string;
}): Promise<{ sectionId: string; seq: number }> {
  return call("POST", "/seed-section", opts);
}

/** spec-286: apply `scope::value`/flat tags to a Spec through applyTagStrings —
 *  the tags the QA Reports feed rail filters + counts on. */
export async function seedTags(opts: {
  memexId: string;
  docId: string;
  tags: string[];
}): Promise<{ applied: { id: string; scope: string | null; value: string }[] }> {
  return call("POST", "/seed-tags", opts);
}

/** Seed an OPEN decision (with options) onto a doc through createDecision.
 *  Returns the decision id + its per-doc seq (the N in the `dec-N` handle). */
export async function seedOpenDecision(opts: {
  memexId: string;
  docId: string;
  title: string;
  context?: string;
  options: { label: string; trade_offs?: string }[];
}): Promise<{ decisionId: string; seq: number }> {
  return call("POST", "/seed-open-decision", opts);
}

/** Resolve a user's role on a doc (editor / reviewer). A freshly seeded doc has
 *  no editor row, so dev resolves to 'reviewer' until promoted in the UI. */
export async function getDocRole(
  memexId: string,
  docId: string,
  userId: string
): Promise<"editor" | "reviewer"> {
  const { role } = await call<{ role: "editor" | "reviewer" }>(
    "GET",
    `/doc-role?docId=${encodeURIComponent(docId)}&memexId=${encodeURIComponent(memexId)}&userId=${encodeURIComponent(userId)}`
  );
  return role;
}

/** Count assignees on a doc. */
export async function getAssigneeCount(memexId: string, docId: string): Promise<number> {
  const { count } = await call<{ count: number }>(
    "GET",
    `/assignee-count?docId=${encodeURIComponent(docId)}&memexId=${encodeURIComponent(memexId)}`
  );
  return count;
}

/** Read a doc's status (e.g. an execution plan flipping to 'approved'). */
export async function getDocStatus(docId: string): Promise<string> {
  const { status } = await call<{ status: string }>("GET", `/doc-status/${docId}`);
  return status;
}

/** Resolve the latest active share token for a doc (null if none). */
export async function getLatestShareToken(
  memexId: string,
  docId: string
): Promise<string | null> {
  const { token } = await call<{ token: string | null }>(
    "GET",
    `/latest-share-token?docId=${encodeURIComponent(docId)}&memexId=${encodeURIComponent(memexId)}`
  );
  return token;
}

/** Mint a share token for a doc through the real service. */
export async function seedShareToken(opts: {
  memexId: string;
  docId: string;
  createdByUserId?: string | null;
}): Promise<{ shareId: string; token: string }> {
  return call("POST", "/seed-share-token", opts);
}

/**
 * Seed the post-`submit_execution_plan` state: a task + linked execution plan +
 * READY readiness comment. Returns the task + plan-doc ids so the journey can
 * read the plan status back after Approve.
 */
export async function seedExecutionPlan(opts: {
  memexId: string;
  docId: string;
  taskTitle?: string;
}): Promise<{ taskId: string; planDocId: string }> {
  return call("POST", "/seed-execution-plan", opts);
}
