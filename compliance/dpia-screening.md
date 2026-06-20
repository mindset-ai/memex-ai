# DPIA screening — authenticated product-usage analytics

**Owner:** Mindset AI (privacy). **Approved via:** git history / PR review. **Decision of record:** [spec-326](https://memex.ai/mindset-prod/memex-building-itself/specs/spec-326) dec-3.

**Screening question: does this processing require a full Data Protection Impact Assessment (DPIA)?**

**No.** Authenticated first-party product-usage analytics, as scoped in spec-326 and in the [Legitimate Interests Assessment](./legitimate-interests-assessment.md), is **not high-risk** processing under UK GDPR Art 35 / ICO criteria:

- **No special-category data** (Art 9): events carry only IDs, enums, and counts — no content, no health/biometric/political/etc. data.
- **No systematic monitoring of a publicly accessible area.**
- **No large-scale processing of special-category or criminal-offence data.**
- **No profiling or automated decision-making with legal or similarly significant effect** (Art 22): the data informs aggregate product decisions, not decisions about individuals.
- **No matching/combining datasets, no targeting of vulnerable subjects, no innovative-tech risk, no denial of service/contract** based on the processing.

It triggers none of the ICO's high-risk indicators (two or more would warrant a DPIA). The processing is transparent (public registry, public source, public LIA), minimised, and escapable (Art-21 opt-out).

**Conclusion:** a full DPIA is **not required**. This screening note, together with the LIA, is the proportionate documentation.
