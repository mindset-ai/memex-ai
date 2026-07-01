// spec-226 t-6 (dec-3) — the designer-facing email-preview gallery.
//
// Lets a logged-in user (on int, without running localhost) browse every
// transactional/lifecycle email's rendered HTML. The template list and each
// template's HTML are fetched via the token-carrying http client (auth is
// Bearer/localStorage, not cookie) and shown in an `<iframe srcDoc>` — an iframe
// `src` pointing straight at the Bearer-auth API route would send no Authorization
// header and 401. The page + its nav entry + route are gated off prod
// (emailPreviewEnabled); the API route is likewise unmounted on prod.
import { useEffect, useState } from "react";
import { fetchWithRetry } from "../api/http";
import { emailPreviewEnabled } from "../utils/devTools";

const TEMPLATES_URL = "/api/__dev__/email-preview/templates";
const previewUrl = (name: string): string =>
  `/api/__dev__/email-preview?template=${encodeURIComponent(name)}`;

export function EmailPreview() {
  const [names, setNames] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [html, setHtml] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendMsg, setSendMsg] = useState<string | null>(null);

  // Load the template list once.
  useEffect(() => {
    let cancelled = false;
    fetchWithRetry(TEMPLATES_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`Could not load templates (${res.status})`);
        return res.json() as Promise<{ templates: string[] }>;
      })
      .then((data) => {
        if (cancelled) return;
        setNames(data.templates);
        setSelected((cur) => cur ?? data.templates[0] ?? null);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the selected template's HTML, then render it via srcDoc (see header note).
  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    setHtml("");
    fetchWithRetry(previewUrl(selected))
      .then((res) => {
        if (!res.ok) throw new Error(`Could not render '${selected}' (${res.status})`);
        return res.text();
      })
      .then((text) => {
        if (!cancelled) setHtml(text);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  // Send the selected template to the logged-in user's OWN inbox (spec-226 dec-4).
  // The recipient is resolved server-side from the session — there is no address
  // field here, so this can't be turned into a send-to-anyone relay.
  const sendToMe = async () => {
    if (!selected) return;
    setSending(true);
    setSendMsg(null);
    try {
      const res = await fetchWithRetry("/api/__dev__/email-preview/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ template: selected }),
      });
      if (!res.ok) throw new Error(`Send failed (${res.status})`);
      const data = (await res.json()) as { to: string };
      setSendMsg(`Sent to ${data.to}`);
    } catch (e) {
      setSendMsg(String(e));
    } finally {
      setSending(false);
    }
  };

  // Defence in depth — the route is already gated, but never render on prod.
  if (!emailPreviewEnabled()) return null;

  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <h1 className="text-xl font-semibold text-primary">Email preview</h1>
      <p className="mt-1 text-sm text-secondary">
        Internal preview of every transactional &amp; lifecycle email. Sample data only — not
        wired to any real send. Available on int and local, never on production.
      </p>

      {error && (
        <p role="alert" className="mt-4 text-sm text-coral">
          {error}
        </p>
      )}

      <div className="mt-6 flex flex-wrap gap-2" role="tablist" aria-label="Email templates">
        {names.map((n) => (
          <button
            key={n}
            type="button"
            role="tab"
            data-testid={`tpl-${n}`}
            aria-selected={n === selected}
            onClick={() => setSelected(n)}
            className={`rounded-md border px-3 py-1.5 text-sm transition-colors ${
              n === selected
                ? "border-edge bg-card-hover text-primary"
                : "border-edge text-secondary hover:text-primary hover:bg-overlay"
            }`}
          >
            {n}
          </button>
        ))}
      </div>

      <div className="mt-6 flex items-center gap-3">
        <button
          type="button"
          data-testid="send-to-me"
          onClick={sendToMe}
          disabled={!selected || sending}
          className="rounded-md border border-edge bg-card-hover px-3 py-1.5 text-sm text-primary transition-colors hover:bg-overlay disabled:opacity-50"
        >
          {sending ? "Sending…" : "Send to my inbox"}
        </button>
        {sendMsg && (
          <span data-testid="send-status" className="text-sm text-secondary">
            {sendMsg}
          </span>
        )}
      </div>

      <div className="mt-4 overflow-hidden rounded-lg border border-edge bg-card">
        <iframe
          title="Email preview"
          srcDoc={html}
          sandbox=""
          className="h-[720px] w-full"
        />
      </div>
    </div>
  );
}

export default EmailPreview;
