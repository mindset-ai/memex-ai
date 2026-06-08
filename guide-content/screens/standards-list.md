---
screen: standards-list
elements: [standards-search, standards-view-toggle, standard-card]
---

# Standards

Standards are your team's durable rules — the conventions, architecture
decisions, and guardrails that every Spec is expected to respect. Where a Spec
captures one unit of work, a Standard captures a rule that outlives any single
piece of work. When code and a Standard disagree, the Standard is usually right
and the code has drifted.

## Browsing and searching standards

Use the search box to filter Standards by title or handle. The view toggle
switches between the list view and a map view that shows how Standards relate to
one another. Each standard card shows the Standard, its drift badge, and when it
was last updated.

## Drift

A Standard's drift badge flags when the codebase appears to have diverged from
the rule the Standard describes. Drift is the enemy of spec-driven development:
the value of a Standard is only as good as how current it is. The Standards
screen is the entry point for understanding and resolving drift across the Memex.
