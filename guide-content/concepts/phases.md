---
topic: phases
---

# The Spec pipeline

Every Spec moves through a fixed pipeline of phases: draft → specify → build →
verify → done, with paused and archived as orthogonal states. The phase a Spec is
in tells you what kind of work it's ready for, and forward moves are gated by a
readiness check so a Spec can't skip ahead of its own evidence. This concept
applies on every screen, which is why it lives as a cross-screen topic rather
than being bound to one view.

## Draft

A Spec starts in draft as a rough statement of intent. You shape the purpose and
surface the open questions here. Nothing is committed yet — draft is for thinking.

## Specify

In specify you turn intent into settled decisions. Each meaningful choice becomes
a decision with its rationale recorded. You resolve decisions here so that the
build that follows is executing a plan, not still making it up.

## Build

Build is where code and tests are written. Tasks become first-class in this
phase — concrete units of work, each gated by acceptance criteria. A task only
exists once the decisions it depends on are resolved.

## Verify

Verify is where the Spec proves itself: tests run, type checks pass, and the
acceptance criteria turn green from tagged tests rather than from assertion. A
Spec reaches verify only when its tasks are complete.

## Done

Closing a Spec to done is a deliberate, human call — never automatic. Done means
the work shipped and its acceptance criteria are verified, and the Spec remains
as a durable record of why the work was done the way it was.
