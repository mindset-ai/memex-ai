// spec-360 t-1 / t-6 — the `scaffold` agent mode is a MODE on the existing
// in-app chat agent graph, not a new agent.
//
// **ac-6** — agentMode includes 'scaffold' and it dispatches through the same
// StateGraph: like drift, scaffold (no bound doc) routes straight to the shared
// agent node (planAgent), so there is no new agent class or LLM client.
// **ac-14** — built on the chat agent independently of spec-316: scaffold is
// routed exactly like drift (a sibling mode), introducing no new graph path.
// **ac-15** — text-only: scaffold reuses the text streaming agent node, never a
// voice/distinct path.

import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { routeByPhase } from './graph';
import type { MessageParam } from './types';

const AC = (n: number) =>
  `mindset-prod/memex-building-itself/specs/spec-360/acs/ac-${n}`;

const baseState = { messages: [] as MessageParam[] };

describe('spec-360 t-1: scaffold is a mode on the chat-agent graph (ac-6)', () => {
  it('routes a doc-less scaffold turn to the shared agent node (planAgent)', () => {
    tagAc(AC(6));
    expect(
      routeByPhase({ ...baseState, docId: null, specPhase: null, agentMode: 'scaffold' }),
    ).toBe('planAgent');
  });

  it('does NOT treat scaffold mode as document creation (no bound doc, but not createDoc)', () => {
    tagAc(AC(6));
    const target = routeByPhase({
      ...baseState,
      docId: null,
      specPhase: null,
      agentMode: 'scaffold',
    });
    expect(target).not.toBe('createDoc');
  });
});

describe('spec-360 t-6: scaffold is a sibling of drift, independent of spec-316 (ac-14)', () => {
  it('routes scaffold exactly like drift — a mode, not a new agent or graph path', () => {
    tagAc(AC(14));
    const drift = routeByPhase({ ...baseState, docId: null, specPhase: null, agentMode: 'drift' });
    const scaffold = routeByPhase({
      ...baseState,
      docId: null,
      specPhase: null,
      agentMode: 'scaffold',
    });
    expect(scaffold).toBe(drift);
  });
});

describe('spec-360 t-6: scaffold is text-only on the streaming agent node (ac-15)', () => {
  it('reuses the text streaming agent node — no distinct voice path', () => {
    tagAc(AC(15));
    // The text streaming agent node the spec/drift modes use. Scaffold lands on
    // the same node, so it is text + streaming (the ChatPanel host), never voice.
    expect(
      routeByPhase({ ...baseState, docId: null, specPhase: null, agentMode: 'scaffold' }),
    ).toBe('planAgent');
    // sanity: the default text agent for a bound spec also resolves to a phase
    // agent node (text), confirming planAgent is the text-surface family.
    expect(
      routeByPhase({ ...baseState, docId: 'doc-1', specPhase: 'specify', agentMode: 'spec' }),
    ).toBe('planAgent');
  });
});
