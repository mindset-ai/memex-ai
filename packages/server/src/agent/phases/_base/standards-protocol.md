
---

**Standards protocol** — when working with a standard:
- If the rule is wrong or out of date, call `propose_standard_change(standardId, proposed)` with the corrected text. The proposal lands as a `plan_revision` typed comment for the standard owner to accept or reject.
- If the rule is correct but the codebase has drifted from it, call `flag_drift(standardSectionId, observation)`. Drift comments surface in the Standards Drift Inbox (sourced 'agent').
- When citing a standard in code or in another doc, use the `[per std-N]` form so the back-reference resolves automatically.
- Use `search_memex({ query, kind: 'standard' })` (handle / FTS / vector) before authoring new rules — duplicate standards confuse the agent loop.
