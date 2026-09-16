// Discriminated-union form of "what does this comment attach to?" — section, decision,
// task, or acceptance criterion. The DB enforces exactly-one-of via the doc_comments_exactly_one_target CHECK
// constraint (see db/schema.ts:67). This type lets new code reach for the type-safe form
// instead of `{ sectionId?, decisionId?, taskId? }` with a runtime XOR check.
//
// Existing call sites (services/comments.ts:getDocForTarget) keep their ad-hoc shape for
// now; new endpoints should accept CommentTarget directly.

export type CommentTarget =
  | { kind: "section"; sectionId: string }
  | { kind: "decision"; decisionId: string }
  | { kind: "task"; taskId: string }
  // spec-566 t-2 (0150). A supersession proposal is a `plan_revision` comment on
  // the criterion itself, so the done-gate can QUERY for an unaccepted proposal
  // rather than parse comment bodies to find one [per std-32].
  | { kind: "ac"; acId: string };

// Bridges the discriminated form to the legacy `{ sectionId?, decisionId?, taskId? }`
// shape used internally. Single source of truth for the mapping.
export function commentTargetToColumns(target: CommentTarget): {
  sectionId?: string;
  decisionId?: string;
  taskId?: string;
  acId?: string;
} {
  switch (target.kind) {
    case "section":
      return { sectionId: target.sectionId };
    case "decision":
      return { decisionId: target.decisionId };
    case "task":
      return { taskId: target.taskId };
    case "ac":
      return { acId: target.acId };
  }
}
