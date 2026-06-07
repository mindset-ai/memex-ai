// The user-facing display name for a Spec phase. spec-181 collapsed the former
// display-name shim: the second phase value is now `specify` end-to-end (enum,
// DB status, API payloads, data-tab attributes), so "Specify" falls straight
// out of capitalising the enum value — there is no longer a plan→"Specify" map
// entry, and every other phase was already pure capitalisation. A trivial
// capitaliser covers every phase ('draft'→"Draft", 'specify'→"Specify",
// 'build'→"Build", 'verify'→"Verify", 'done'→"Done") and degrades gracefully
// for non-phase statuses (e.g. 'cross_reference'→"Cross reference").
export function phaseDisplayName(phase: string): string {
  return phase.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}
