// Per dec-3 / dec-4 of doc-10 the Spec lifecycle is `draft → specify → build →
// verify → done`. Kanban renders the four active columns; `done` lives in a
// collapsible rail on the right (dec-5). `approved` is execution-plan-only
// (t-20 W-B) and never appears on a spec card.
// spec-355 dry-1: the kanban status set IS the canonical SpecPhase pipeline.
import type { SpecPhase } from '@memex/shared';
export type SpecKanbanStatus = SpecPhase;
export type ActiveStatus = Exclude<SpecKanbanStatus, 'done'>;
