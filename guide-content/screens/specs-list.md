---
screen: specs-list
elements: [new-spec-button, spec-card, spec-card-health, phase-columns, search-trigger]
---

# The Specs board

The Specs board is the home of a Memex and every new user's entry point. It is a
Kanban board where each card is a Spec — a living document that captures the
purpose, decisions, tasks, and acceptance criteria for one unit of work. Specs
move left-to-right across phase columns as the work progresses.

## Creating a Spec

Use the new-spec button to start a Spec. A Spec begins in the `draft` phase as a
rough statement of intent; you flesh out its purpose and decisions before any
work is committed. You don't need to fill everything in up front — a Spec is meant
to grow as understanding does.

## Spec cards

Each card on the board is one Spec. A card shows the Spec's title, who is assigned
to move it right now, its current phase, and the health of its acceptance
criteria. Drag a card between columns to change its phase, or open it to work on
the detail.

## Acceptance-criteria health

The health strip on a card summarises how many of the Spec's acceptance criteria
are verified by passing tagged tests. Green means the criteria are backed by
green tests; red means there are criteria with no test or a failing test. The
strip is how you tell at a glance whether a Spec's claims are actually proven.

## The phase columns

The board is organised into the pipeline phases: draft, specify, build, and
verify (with done and archived as terminal states). A Spec lives in exactly one
phase at a time, and the column it sits in tells you what kind of work it's ready
for — shaping intent in draft/specify, writing code and tests in build, proving
it in verify.

## Finding a Spec quickly

Press ⌘K (or use the search trigger) to open the command palette. From there you
can jump to any Spec by title or by number — type a number to jump straight to
that Spec. The palette is the fastest way to navigate a Memex with many Specs.
