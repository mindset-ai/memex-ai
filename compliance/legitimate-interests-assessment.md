# Legitimate Interests Assessment — authenticated product-usage analytics

**Owner:** Mindset AI (privacy). **Approved via:** git history / PR review — whoever merges this to `main` owns it. There is no separate sign-off step; this file being in `main` is the record.

**Scope:** first-party, in-product usage analytics for **authenticated** users of Memex — registered event names carrying only IDs, enums, and counts (no document content, message text, or keystrokes; the full event registry is public in the codebase). The identifier is `user_id`; the durable `visitor_id` cookie is not used post-authentication. Anonymous pre-signup capture stays opt-in (spec-254) and is out of scope here.

**Decision of record:** [spec-326](https://memex.ai/mindset-prod/memex-building-itself/specs/spec-326) dec-1 / dec-3 — authenticated users are tracked by default under **legitimate interest** (UK GDPR Art 6(1)(f)), with privacy-notice disclosure and a settings opt-out as the Art-21 right to object. Deliberately **not** bundled "consent in the Terms" (invalid consent under GDPR).

## 1. Purpose test — is there a legitimate interest?

Yes. Mindset has a legitimate interest in understanding how authenticated users use Memex (which value paths they walk, where flows stall) to improve product quality, reliability, and roadmap decisions. First-party product analytics for a service the user has chosen to use is a well-established legitimate interest.

## 2. Necessity test — is the processing necessary, and minimised?

Yes, and it is minimised. Only registered event names carrying IDs, enums, and counts are captured — no document content, message text, or keystrokes (sanitised both client- and server-side; the registry is public). The identifier is the authenticated `user_id`; the durable cross-property `visitor_id` cookie is not used post-authentication, removing the ePrivacy surface. An opt-in popup yields a self-selected, unrepresentative minority and effectively blinds the team — there is no less-intrusive way to obtain reliable in-product usage signal.

## 3. Balancing test — do the individual's interests override the interest?

No, on balance. Factors keeping impact low:

- data is minimal and non-content;
- the event registry is public (the processing is transparent — and so is this assessment);
- the user is an authenticated user in an ongoing service relationship and would reasonably expect product-usage measurement;
- a clear privacy notice is shown at signup;
- a one-click right to object is always available in Settings → Product-usage analytics;
- no special-category data, no automated decision-making with legal/similarly-significant effect, no profiling, no third-party sale or sharing.

The processing is not a surprise and is easily escapable, so it does not override the individual's rights and freedoms.

## Safeguards relied on

Data minimisation (IDs/enums/counts only), public event registry, public source code and this public assessment, the signup privacy notice, the persistent settings opt-out (Art-21), and dropping the durable `visitor_id` cookie post-authentication.

## Conclusion

Legitimate interest is an appropriate lawful basis for authenticated first-party product analytics as scoped. Anonymous pre-signup capture remains opt-in (spec-254) and is outside this assessment.
