// API client for /api/orgs/:orgId/scaffold/* — the Inspect surface (b-68 t-10).
//
// Wraps the read endpoint (`GET /scaffold`) and the admin-only write endpoints
// (`POST/PATCH/DELETE /scaffold/additions` + `POST /scaffold/additions/:id/toggle`).
//
// Per std-7, unauthorized callers see a 404 — both for non-members on read and
// for non-admins on writes. Callers translate the resulting error however they
// prefer (the Inspect page surfaces it as a toast).
//
// `ScaffoldFetchResponse` carries the base ScaffoldDataset plus the principal's
// Org GuidanceBlocks. Org rows extend the shared `GuidanceBlock` shape with a
// persisted `id` so the UI can target individual rows on PATCH/DELETE.

import type {
  GuidanceBlock,
  GuidanceEmphasis,
  GuidanceTarget,
  ScaffoldDataset,
} from '@memex/shared';
import { fetchWithRetry } from './http';
import { BASE_URL } from './http';

/** Org row as returned by the server — `GuidanceBlock` plus persisted `id`. */
export interface OrgScaffoldAddition extends GuidanceBlock {
  id: string;
}

/** GET /api/orgs/:orgId/scaffold response payload. */
export interface ScaffoldFetchResponse {
  base: ScaffoldDataset;
  org: OrgScaffoldAddition[];
}

/** Body for POST /scaffold/additions. */
export interface CreateScaffoldAdditionInput {
  target: GuidanceTarget;
  text: string;
  rationale: string;
  emphasis?: GuidanceEmphasis;
  enabled?: boolean;
  order?: number;
  // spec-193 t-5: optional per-memex scope. Omitted = account-wide; a memex
  // UUID scopes the block to that one memex.
  memexId?: string;
}

/** Body for PATCH /scaffold/additions/:id. `emphasis: null` clears the field. */
export interface UpdateScaffoldAdditionInput {
  target?: GuidanceTarget;
  text?: string;
  rationale?: string;
  emphasis?: GuidanceEmphasis | null;
  enabled?: boolean;
  order?: number;
  // spec-193 t-5: re-scope. `null` clears back to account-wide.
  memexId?: string | null;
}

function scaffoldBase(orgId: string): string {
  return `${BASE_URL}/orgs/${encodeURIComponent(orgId)}/scaffold`;
}

async function asJsonOrThrow<T>(res: Response, fallbackMessage: string): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new Error(body.error ?? body.message ?? `${fallbackMessage}: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

/**
 * Fetch the merged Inspect payload for an Org. Available to any active member;
 * non-members get a 404 which surfaces as an error.
 */
export async function fetchScaffold(orgId: string): Promise<ScaffoldFetchResponse> {
  const res = await fetchWithRetry(scaffoldBase(orgId));
  return asJsonOrThrow<ScaffoldFetchResponse>(res, 'Failed to fetch scaffold');
}

/** Admin-only: create a new Org GuidanceBlock. */
export async function createScaffoldAddition(
  orgId: string,
  input: CreateScaffoldAdditionInput,
): Promise<OrgScaffoldAddition> {
  const res = await fetchWithRetry(`${scaffoldBase(orgId)}/additions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return asJsonOrThrow<OrgScaffoldAddition>(res, 'Failed to create scaffold addition');
}

/** Admin-only: update an existing Org GuidanceBlock. */
export async function updateScaffoldAddition(
  orgId: string,
  id: string,
  input: UpdateScaffoldAdditionInput,
): Promise<OrgScaffoldAddition> {
  const res = await fetchWithRetry(`${scaffoldBase(orgId)}/additions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return asJsonOrThrow<OrgScaffoldAddition>(res, 'Failed to update scaffold addition');
}

/** Admin-only: delete an Org GuidanceBlock. Returns void on success. */
export async function deleteScaffoldAddition(orgId: string, id: string): Promise<void> {
  const res = await fetchWithRetry(`${scaffoldBase(orgId)}/additions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    throw new Error(body.error ?? body.message ?? `Failed to delete scaffold addition: ${res.status}`);
  }
}

/** Admin-only: flip the `enabled` flag on an Org GuidanceBlock. */
export async function toggleScaffoldAddition(
  orgId: string,
  id: string,
  enabled: boolean,
): Promise<OrgScaffoldAddition> {
  const res = await fetchWithRetry(
    `${scaffoldBase(orgId)}/additions/${encodeURIComponent(id)}/toggle`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    },
  );
  return asJsonOrThrow<OrgScaffoldAddition>(res, 'Failed to toggle scaffold addition');
}
