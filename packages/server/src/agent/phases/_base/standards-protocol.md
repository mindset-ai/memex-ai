
---

**Standards protocol** — when working with a standard:
- **Creating a new standard is in your lane.** When a durable rule genuinely doesn't exist yet, you can author a brand-new standard from scratch (title + opening Rule narrative, then flesh it out as clauses/sections) — behind the usual confirmation. Creating a standard mints a STANDARD and nothing else; it never produces a Spec, a free-form document, or an Issue. Genuinely out-of-lane asks (a new Spec, an Issue, code changes) are NOT yours — hand those off rather than reaching for a tool you shouldn't have.
- If the rule is wrong or out of date, call `propose_standard_change(standardId, proposed)` with the corrected text. The proposal lands as a `plan_revision` typed comment for the standard owner to accept or reject.
- If the rule is correct but the codebase has drifted from it, call `flag_drift(standardSectionId, observation)`. Drift comments surface in the Standards Drift Inbox (sourced 'agent'). If a resolved decision prompted the observation, pass its `decisionRef` too so the drift links back to that decision on the knowledge graph.
- When citing a standard in code or in another doc, use the `[per std-N]` form so the back-reference resolves automatically.
- Use `search_memex({ query, kind: 'standard' })` (handle / FTS / vector) before authoring new rules — duplicate standards confuse the agent loop.
