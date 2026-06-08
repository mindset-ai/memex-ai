// spec-206 t-2 (dec-1): lift the Handhold reveal pointer to a SHARED, orchestrator-
// commandable surface.
//
// spec-178 instantiated `useHandholdReveal` as LOCAL state in two places
// (SpecList + DocDocument), reconciled only through localStorage on mount. The
// Specky synced walkthrough (spec-206 dec-1) needs the voice orchestrator to drive
// the SAME pointer the board reads, so Specky's narration and the visible board
// advance together. This provider owns one pointer per tenant and hands it to both
// the pages and the voice layer (App.tsx threads `advance` into the orchestrator's
// react deps → the `advance_demo` guide tool).
//
// Back-compat: the consumer hook FALLS BACK to a standalone `useHandholdReveal`
// when no provider is mounted, so the pages still work in isolation (the many
// existing SpecList/DocDocument tests render them without this provider).

import { createContext, useContext, type ReactNode } from 'react';
import { useHandholdReveal, type HandholdReveal } from './useHandholdReveal';

const HandholdRevealContext = createContext<HandholdReveal | null>(null);

/** Owns one reveal pointer for the current tenant and shares it with every
 *  descendant (board pages + the voice layer). Key this by `${ns}/${mx}` at the
 *  call site so it re-reads the per-tenant localStorage pointer on tenant change. */
export function HandholdRevealProvider({
  namespace,
  memex,
  children,
}: {
  namespace: string | null;
  memex: string | null;
  children: ReactNode;
}): React.JSX.Element {
  const reveal = useHandholdReveal(namespace, memex);
  return (
    <HandholdRevealContext.Provider value={reveal}>
      {children}
    </HandholdRevealContext.Provider>
  );
}

/**
 * The reveal pointer for the current tenant. Returns the shared provider value
 * when one is mounted (the real app), otherwise a standalone instance keyed by the
 * passed tenant (test/isolation fallback). `useHandholdReveal` is always called so
 * the rules of hooks hold regardless of which branch wins.
 */
export function useHandholdRevealValue(
  ns: string | null,
  mx: string | null,
): HandholdReveal {
  const shared = useContext(HandholdRevealContext);
  const standalone = useHandholdReveal(ns, mx);
  return shared ?? standalone;
}
