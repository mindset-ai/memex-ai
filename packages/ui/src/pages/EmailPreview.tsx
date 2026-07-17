// spec-226 t-6 (dec-3) — the designer-facing email-preview gallery.
// spec-493 t-2 (dec-2/dec-3) — the gallery renders the activation onboarding sequence as
// a TIMELINE with each email's send condition (day / cohort / trigger / flag), and keeps
// the non-onboarding templates (system/sign-in mail, superseded samples) in a separate
// grouped list. The condition metadata is served by /email-preview/templates, whose
// day/comms facts are imported from the real send path (send-conditions.ts) so the
// timeline cannot silently disagree with what actually sends.
//
// Lets a logged-in user (on int, without running localhost) browse every
// transactional/lifecycle email's rendered HTML. The template list and each template's
// HTML are fetched via the token-carrying http client (auth is Bearer/localStorage, not
// cookie) and shown in an `<iframe srcDoc>` — an iframe `src` pointing straight at the
// Bearer-auth API route would send no Authorization header and 401. The page + its nav
// entry + route are gated off prod (emailPreviewEnabled); the API route is likewise
// unmounted on prod.
import { useEffect, useMemo, useState } from "react";
import { fetchWithRetry } from "../api/http";
import { emailPreviewEnabled } from "../utils/devTools";

const TEMPLATES_URL = "/api/__dev__/email-preview/templates";
const previewUrl = (name: string): string =>
  `/api/__dev__/email-preview?template=${encodeURIComponent(name)}`;

type TimelineBranch = "main" | "connected-inactive" | "win-back";

interface OnboardingMeta {
  name: string;
  sequence: true;
  order: number;
  dayOffset: number | null;
  anchor: string;
  cohort: string;
  trigger: string;
  branch: TimelineBranch;
  flagGated: boolean;
  commsKey: string | null;
}
interface OtherMeta {
  name: string;
  sequence: false;
}
type TemplateMeta = OnboardingMeta | OtherMeta;

const isOnboarding = (t: TemplateMeta): t is OnboardingMeta => t.sequence;

const dayLabel = (m: OnboardingMeta): string =>
  m.dayOffset === null ? "Event-driven" : `Day ${m.dayOffset}`;

// A single selectable email chip — used both on the timeline and in the grouped list, so
// selection + preview behaviour is identical everywhere (ac-4).
function EmailChip({
  name,
  selected,
  onSelect,
}: {
  name: string;
  selected: boolean;
  onSelect: (name: string) => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      data-testid={`tpl-${name}`}
      aria-selected={selected}
      onClick={() => onSelect(name)}
      className={`cursor-pointer rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
        selected
          ? "border-accent bg-accent text-on-accent"
          : "border-edge text-secondary hover:text-primary hover:bg-overlay"
      }`}
    >
      {name}
    </button>
  );
}

// The send-condition line shown under each timeline email (ac-2): day/offset, who it
// targets, what triggers it, and whether it's held behind the activation flag.
function ConditionLine({ meta }: { meta: OnboardingMeta }) {
  return (
    <div data-testid={`cond-${meta.name}`} className="mt-1 space-y-0.5 text-xs text-secondary">
      <div>
        <span className="font-medium text-primary">{dayLabel(meta)}</span>
        <span className="text-muted"> · after {meta.anchor}</span>
      </div>
      <div>Who: {meta.cohort}</div>
      <div>Trigger: {meta.trigger}</div>
      <div>
        {meta.flagGated ? (
          <span className="text-muted">Held behind the activation flag</span>
        ) : (
          <span className="text-muted">Always sends (transactional)</span>
        )}
      </div>
    </div>
  );
}

// One timeline email: its chip + condition line, laid out as a spine node.
function TimelineNode({
  meta,
  selected,
  onSelect,
}: {
  meta: OnboardingMeta;
  selected: boolean;
  onSelect: (name: string) => void;
}) {
  return (
    <div className="rounded-lg border border-edge bg-card p-3">
      <EmailChip name={meta.name} selected={selected} onSelect={onSelect} />
      <ConditionLine meta={meta} />
    </div>
  );
}

export function EmailPreview() {
  const [templates, setTemplates] = useState<TemplateMeta[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [html, setHtml] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sendMsg, setSendMsg] = useState<string | null>(null);

  // Load the template metadata once.
  useEffect(() => {
    let cancelled = false;
    fetchWithRetry(TEMPLATES_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`Could not load templates (${res.status})`);
        return res.json() as Promise<{ templates: TemplateMeta[] }>;
      })
      .then((data) => {
        if (cancelled) return;
        setTemplates(data.templates);
        setSelected((cur) => cur ?? data.templates[0]?.name ?? null);
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

  // Split into the ordered onboarding timeline and the flat grouped list (dec-3). The
  // timeline is grouped into order slots; a slot with >1 email is a set of mutually
  // exclusive parallel cohort branches (welcome→cohort nudge→milestone→day-12).
  const { slots, others } = useMemo(() => {
    const onboarding = templates.filter(isOnboarding).sort((a, b) => a.order - b.order);
    const byOrder = new Map<number, OnboardingMeta[]>();
    for (const m of onboarding) {
      const bucket = byOrder.get(m.order) ?? [];
      bucket.push(m);
      byOrder.set(m.order, bucket);
    }
    return {
      slots: [...byOrder.entries()].sort((a, b) => a[0] - b[0]).map(([, ms]) => ms),
      others: templates.filter((t): t is OtherMeta => !t.sequence),
    };
  }, [templates]);

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

      {/* The activation onboarding sequence, in send order, with each email's send
          condition — the ordered journey, not a flat tab strip (ac-1/ac-2). */}
      <section aria-label="Activation onboarding sequence" className="mt-6">
        <h2 className="text-sm font-semibold text-primary">Onboarding sequence</h2>
        <p className="mt-0.5 text-xs text-muted">
          The order emails fire, and the condition each depends on.
        </p>
        <ol data-testid="email-timeline" className="mt-3 space-y-3">
          {slots.map((slot, i) =>
            slot.length === 1 ? (
              <li key={slot[0].name}>
                <TimelineNode
                  meta={slot[0]}
                  selected={selected === slot[0].name}
                  onSelect={setSelected}
                />
              </li>
            ) : (
              // A parallel-branch slot: mutually exclusive cohorts — a user gets ONE of
              // these, never both (ac-12). Rendered side by side, not as two steps.
              <li key={`slot-${i}`}>
                <div className="text-xs text-muted">One of, by cohort:</div>
                <div
                  data-testid="cohort-branches"
                  className="mt-1 grid gap-3 sm:grid-cols-2"
                >
                  {slot.map((meta) => (
                    <TimelineNode
                      key={meta.name}
                      meta={meta}
                      selected={selected === meta.name}
                      onSelect={setSelected}
                    />
                  ))}
                </div>
              </li>
            ),
          )}
        </ol>
      </section>

      {/* Everything that isn't part of the ordered journey — system/sign-in mail and
          superseded samples — kept clearly separate, never forced onto the timeline
          (ac-5/ac-11). */}
      <section aria-label="System and other emails" className="mt-8">
        <h2 className="text-sm font-semibold text-primary">System &amp; other emails</h2>
        <p className="mt-0.5 text-xs text-muted">
          Event-triggered mail — not part of the onboarding journey.
        </p>
        <div
          data-testid="other-emails"
          className="mt-3 flex flex-wrap gap-2"
          role="tablist"
          aria-label="Other email templates"
        >
          {others.map((t) => (
            <EmailChip
              key={t.name}
              name={t.name}
              selected={selected === t.name}
              onSelect={setSelected}
            />
          ))}
        </div>
      </section>

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
        <iframe title="Email preview" srcDoc={html} sandbox="" className="h-[720px] w-full" />
      </div>
    </div>
  );
}

export default EmailPreview;
