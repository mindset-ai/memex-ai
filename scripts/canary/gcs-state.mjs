// spec-243 dec-4: consecutive-failure state for the Cloud Run runner.
//
// Cloud Run has no "previous workflow run" to query, so the last status per env
// is persisted as a tiny JSON object in GCS. Zero npm deps: we mint an access
// token from the instance metadata server (the Job's service account) and call
// the GCS JSON API over plain fetch — keeps the container image a stock
// node:alpine with no @google-cloud/storage.
//
// Object layout: gs://$CANARY_STATE_BUCKET/canary-state/<env>.json → {"status":"green|red"}
//
// Fail-soft: any read error returns 'unknown' (treated as consecutive for a red,
// so we err toward alerting, never toward silent). A write error is logged and
// swallowed — a missed write only costs a slightly stale prevStatus next run.

const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

async function accessToken() {
  const res = await fetch(METADATA_TOKEN_URL, {
    headers: { "Metadata-Flavor": "Google" },
  });
  if (!res.ok) throw new Error(`metadata token ${res.status}`);
  return (await res.json()).access_token;
}

function objectPath(env) {
  return encodeURIComponent(`canary-state/${env}.json`);
}

// Returns 'red' | 'green' | 'none' | 'unknown'. 'none' = object doesn't exist
// yet (first run); 'unknown' = a real error reaching GCS.
export async function readPrevStatus(bucket, env) {
  if (!bucket) return "unknown";
  try {
    const token = await accessToken();
    const res = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${objectPath(env)}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (res.status === 404) return "none";
    if (!res.ok) {
      console.error(`[canary-state] read ${env} → ${res.status}`);
      return "unknown";
    }
    const body = await res.json();
    return body.status === "red" || body.status === "green" ? body.status : "unknown";
  } catch (err) {
    console.error(`[canary-state] read ${env} failed: ${err}`);
    return "unknown";
  }
}

export async function writeStatus(bucket, env, status) {
  if (!bucket) return;
  try {
    const token = await accessToken();
    const res = await fetch(
      `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${objectPath(env)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ status }),
      },
    );
    if (!res.ok) console.error(`[canary-state] write ${env} → ${res.status}`);
  } catch (err) {
    console.error(`[canary-state] write ${env} failed: ${err}`);
  }
}
