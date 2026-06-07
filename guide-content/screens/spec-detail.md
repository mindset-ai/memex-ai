---
screen: spec-detail
elements: [phase-pill, phase-transition-button, decisions-panel, tasks-panel, acs-panel, chat-panel, share-button]
---

# The Spec detail view

The Spec detail view is where you spend most of your time: reading a Spec's
narrative, resolving its decisions, tracking its tasks, and watching its
acceptance criteria turn green. A Spec is a living node — it captures not just
what to build but why, so the reasoning survives long after the work ships.

## The phase pill and moving forward

The phase pill shows the Spec's current phase: draft, specify, build, verify, or
done. The phase-transition button advances the Spec to the next phase. Before a
forward move the system runs a readiness check — for example, you can't move into
build with open decisions, and you can't reach verify until the tasks are
complete. The pipeline keeps a Spec honest about what's actually been settled.

## Decisions

The decisions panel lists the questions this Spec has had to answer, each as a
candidate, open, or resolved decision. Decisions are resolved before the work
they gate begins — a decision is the place where a choice and its rationale are
recorded, so resolve them first and let tasks follow.

## Tasks

The tasks panel lists the concrete units of work. Tasks are first-class in the
build phase — a task in an earlier phase is a guess pretending to be a
commitment, so tasks are created once decisions are settled and the Spec is in
build.

## Acceptance criteria

The acceptance-criteria panel lists what the Spec must do, each with its live
verification state derived from tagged tests. A criterion is `verified` when its
tagged tests pass, `failing` when a test is red, and `untested` when no test
references it yet. This panel is the Spec's proof that its promises hold.

## Chat and sharing

The chat panel is the in-app agent you collaborate with on this Spec — it can
read and edit the Spec with you. The share button lets you share the Spec with
teammates or externally. Note the boundary: this in-app agent works with your
Spec's data; the voice guide only teaches you how the product works.
