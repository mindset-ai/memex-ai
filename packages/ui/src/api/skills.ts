// spec-300 t-6 — the Skills API client. Wraps the tenant-scoped REST surface the
// server exposes under `/api/<namespace>/<memex>/skills` (built in t-10):
//
//   GET    /skills                 — list active skills (metadata only)
//   GET    /skills/:handle         — one skill: verbatim SKILL.md + file TOC
//   GET    /skills/:handle/files/* — inline text OR a signed read URL for one file
//   POST   /skills                 — create from SKILL.md (+ capabilities, files)
//   PATCH  /skills/:handle          — edit SKILL.md / capabilities
//   DELETE /skills/:handle          — archive (soft-delete)
//
// The wire shapes mirror the server's SkillListItem / SkillView / SkillFileAccess.
// Binary auxiliary files ride as base64 (JSON can't carry raw bytes); text files
// ride as `text`. Exactly one of the two per file (the server enforces this).

import { fetchJson } from './fetchJson';
import { fetchWithRetry } from './http';
import { tBase } from './internal';

// ── Wire types (mirror packages/server/.../skills-service.ts) ─────────────────

/** Memex-native capability flags authored ON a skill (dec-20). Inform routing;
 *  enforce nothing. Always a complete, closed set server-side. */
export interface SkillCapabilities {
  readonly codebaseAccess: boolean;
  readonly codeEditing: boolean;
  readonly externalTools: boolean;
}

export const EMPTY_CAPABILITIES: SkillCapabilities = {
  codebaseAccess: false,
  codeEditing: false,
  externalTools: false,
};

/** The list shape — metadata only (no body, no allowed-tools). */
export interface SkillListItem {
  readonly ref: string;
  readonly handle: string;
  readonly name: string;
  readonly description: string;
  readonly capabilities: SkillCapabilities;
}

/** One table-of-contents entry — path/purpose/type/size, NEVER contents (ac-15). */
export interface SkillFileTocEntry {
  readonly path: string;
  readonly purpose: string | null;
  readonly contentType: string;
  readonly size: number;
}

/** The read shape — verbatim SKILL.md plus a file TOC. */
export interface SkillView {
  readonly ref: string;
  readonly handle: string;
  readonly name: string;
  readonly description: string;
  readonly capabilities: SkillCapabilities;
  readonly skillMd: string;
  readonly files: readonly SkillFileTocEntry[];
}

/** One file's byte-access result: inline text, or a short-TTL signed URL (ac-16). */
export type SkillFileAccess =
  | { readonly kind: 'inline'; readonly contentType: string; readonly text: string }
  | { readonly kind: 'bucket'; readonly contentType: string; readonly url: string };

/** One auxiliary-file payload for create. Exactly one of `text` / `contentBase64`. */
export interface SkillFileUpload {
  readonly path: string;
  readonly purpose?: string;
  readonly contentType?: string;
  /** UTF-8 text content (inline storage). */
  readonly text?: string;
  /** base64-encoded bytes (blob storage) — for fonts, images, other binaries. */
  readonly contentBase64?: string;
}

export interface CreateSkillInput {
  readonly skillMd: string;
  readonly capabilities?: Partial<SkillCapabilities>;
  readonly files?: readonly SkillFileUpload[];
}

export interface EditSkillInput {
  readonly skillMd?: string;
  readonly capabilities?: Partial<SkillCapabilities>;
  /**
   * spec-300 t-16 (dec-24): auxiliary files to ADD or REPLACE (a file at an
   * existing path is replaced). Binary rides as base64 `contentBase64`, text as
   * `text` — exactly like create. The PATCH route (issue-7) persists them.
   */
  readonly files?: readonly SkillFileUpload[];
  /** spec-300 t-16 (dec-24): auxiliary-file paths to REMOVE from the skill. */
  readonly removeFiles?: readonly string[];
}

/** A validated, spec-compliant SKILL.md drafted from a plain-language description
 *  (spec-300 t-15 Increment 1, ac-49/ac-21). The server has already run the same
 *  validateSkill the create path runs; the UI persists `skillMd` on confirm. */
export interface DraftedSkill {
  readonly skillMd: string;
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

// ── Endpoints ─────────────────────────────────────────────────────────────────

/** List the current Memex's active skills, alphabetical by name (server-sorted). */
export async function fetchSkills(): Promise<SkillListItem[]> {
  return fetchJson<SkillListItem[]>(fetchWithRetry, `${tBase()}/skills`);
}

/** Read one skill: verbatim SKILL.md + auxiliary-file TOC. 404 → ApiError. */
export async function fetchSkill(handle: string): Promise<SkillView> {
  return fetchJson<SkillView>(fetchWithRetry, `${tBase()}/skills/${handle}`);
}

/** Mint byte access for one auxiliary file (inline text or a signed URL). The
 *  path can contain slashes, so each segment is encoded but the separators kept. */
export async function fetchSkillFile(
  handle: string,
  path: string,
): Promise<SkillFileAccess> {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return fetchJson<SkillFileAccess>(
    fetchWithRetry,
    `${tBase()}/skills/${handle}/files/${encoded}`,
  );
}

/**
 * Create a skill from a SKILL.md. Surfaces the server's validation message
 * verbatim on 4xx (inline-error UX in the create flow) — fetchJson throws an
 * ApiError carrying `message`, so callers show `err.message`.
 */
export async function createSkill(input: CreateSkillInput): Promise<SkillView> {
  return fetchJson<SkillView>(fetchWithRetry, `${tBase()}/skills`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

/** Edit a skill's SKILL.md and/or capability flags. */
export async function editSkill(
  handle: string,
  input: EditSkillInput,
): Promise<SkillView> {
  return fetchJson<SkillView>(fetchWithRetry, `${tBase()}/skills/${handle}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

/**
 * Draft a spec-compliant SKILL.md from a plain-language description (ac-49/ac-21).
 * The server drafts + validates and returns the SKILL.md for review; the create
 * flow persists it via createSkill on confirm. A 4xx surfaces its message verbatim.
 */
export async function draftSkill(description: string): Promise<DraftedSkill> {
  return fetchJson<DraftedSkill>(fetchWithRetry, `${tBase()}/skills/draft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ description }),
  });
}

/** Archive (soft-delete) a skill. 204 on success. */
export async function deleteSkill(handle: string): Promise<void> {
  const res = await fetchWithRetry(`${tBase()}/skills/${handle}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Failed to delete skill: ${res.status}`);
  }
}
