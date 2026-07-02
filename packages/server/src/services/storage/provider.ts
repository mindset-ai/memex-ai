// Pluggable auxiliary-file STORAGE layer (spec-300, dec-19).
//
// A `StorageProvider` is the seam that lets a self-hosting forker nominate
// WHERE auxiliary-file bytes live (local filesystem, GCS, one day S3) purely
// via env — never a code change. The provider's job is narrow on purpose:
//
//   * mint a short-lived signed UPLOAD url (client PUTs bytes straight to it),
//   * mint a short-lived signed READ url (client GETs bytes straight from it),
//   * delete an object.
//
// SEPARATION OF CONCERNS (dec-19) — READ THIS BEFORE ADDING CODE HERE:
// The provider ONLY mints URLs / moves bytes. It performs NO tenancy or
// authorization checks. "Does this caller have access to the Memex that owns
// this key?" is answered by the CALLER (a route/service) BEFORE it ever asks
// the provider for a URL. Do not push memex_id / RLS / membership logic down
// into a driver — that would couple byte-storage to our tenant model and break
// the drop-in promise for forkers. The signed URL is a bearer credential scoped
// to one key for a few minutes; authorization is what decides whether we hand
// it out at all.
//
// Buckets/objects are ALWAYS PRIVATE. No driver may ever make an object public
// (ac-16: aux bytes are delivered only via a short-lived signed URL).

/** How long a minted URL stays valid. ~15 min keeps a leaked URL cheap. */
export const DEFAULT_URL_TTL_SECONDS = 15 * 60;

export type StorageProviderKind = "local" | "gcs" | "s3";

/** A signed target the client PUTs bytes to. */
export interface UploadTarget {
  /** Absolute (gcs) or app-relative (local) URL to PUT bytes to. */
  readonly url: string;
  /** HTTP method the client must use. Always PUT for our drivers. */
  readonly method: "PUT";
  /**
   * Headers the client MUST send with the PUT so the signature matches
   * (e.g. content-type). Empty object when the driver pins nothing.
   */
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * The storage seam. One instance per process, selected by env at the factory.
 * Implementations must treat `key` as an opaque object path — the caller owns
 * key naming (and has already authorized the caller for that key's Memex).
 */
export interface StorageProvider {
  /** Which driver this is — handy for logs and the factory's own tests. */
  readonly kind: StorageProviderKind;

  /**
   * Mint a short-lived signed URL the client PUTs bytes to.
   * @param key object path (opaque; caller-owned; already authorized)
   * @param contentType MIME type the upload will carry (pinned into the signature)
   */
  getUploadUrl(key: string, contentType: string): Promise<UploadTarget>;

  /**
   * Mint a short-lived (~15 min) signed URL the client GETs bytes from.
   * Never returns a public/permanent URL (ac-16).
   */
  getSignedReadUrl(key: string): Promise<string>;

  /** Delete an object. Idempotent — deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
}
