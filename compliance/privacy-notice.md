# Privacy notice — product-usage analytics

**Owner:** Mindset AI (privacy / legal own the final public wording). **Approved via:** git history / PR review. **Decision of record:** [spec-326](https://memex.ai/mindset-prod/memex-building-itself/specs/spec-326) dec-1 / dec-3.

This is the substance of the product-usage-analytics clause. The canonical, customer-facing version lives in the public privacy policy on the site; this in-repo copy keeps the source code and the privacy posture consistent. The short form is also shown at signup (`data-testid="signup-privacy-notice"`).

## Clause

> **Product-usage analytics.** When you are signed in, Memex records anonymous product-usage events — which features and value paths you use — to understand how the product is used and to improve it. These events carry only identifiers, category labels, and counts: **no document content, no message text, and no keystrokes**. The full list of events we record is public in our event registry.
>
> **Lawful basis: legitimate interest** (UK GDPR Article 6(1)(f)) — improving a product you have chosen to use. We have assessed that this processing is proportionate and does not override your rights; our [Legitimate Interests Assessment](./legitimate-interests-assessment.md) is public.
>
> **Your right to object.** You can turn product-usage analytics off at any time in **Settings → Product-usage analytics**. We treat UK and EU users the same way.

## Notes

- Lawful basis is **legitimate interest, not bundled consent in the Terms** — bundled consent is invalid under GDPR (must be freely given, specific, unbundled, not a condition of service).
- Anonymous pre-signup visitors remain **opt-in** (spec-254); the banner there is unchanged.
