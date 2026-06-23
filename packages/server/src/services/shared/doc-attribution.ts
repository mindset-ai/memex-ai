// Document-attribution props for back-end outcome usage events (spec-306).
//
// The whitelisted back-end Mixpanel events (task.created, decision.resolved,
// document.status_changed, conversation_message.created, document.created) ride
// the mutate() ChangeEvent.payload into usage_events.props and on to Mixpanel via
// sanitizeUsageProps (std-35 Recipe B). This helper is the ONE place the property
// shape lives so the five emit sites and their tests can't drift.
//
// dec-1: the identifier is the document's opaque UUID (`documents.id`) plus its
// doc_type enum — never the human handle, namespace, or Memex slug. That keeps
// spec-244's privacy posture (memex_id is still not forwarded) while staying
// globally unique. Both values are scalars that pass sanitizeUsageProps unchanged
// (UUID < 64 chars and not email-shaped; doc_type is a short enum).

/**
 * Build the `{ doc_id, doc_type }` attribution props for an outcome event.
 * `id` is the attributed document's `documents.id`; for the doc-CHILD events
 * (task / decision / conversation) that is the PARENT Spec, for document.created
 * it is the new document itself (spec-306 dec-2).
 *
 * Returns `Record<string, unknown>` so it drops straight into a ChangeKey's
 * `payload` (and merges with sibling props like {from,to} or {spec_index}).
 */
export function docAttribution(id: string, docType: string): Record<string, unknown> {
  return { doc_id: id, doc_type: docType };
}
