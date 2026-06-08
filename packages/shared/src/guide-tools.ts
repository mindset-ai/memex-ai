// spec-190 t-5 / dec-4: the guide's canonical toolset — the ONE source for the
// tools the voice guide may call (mirrors std-16's single-source principle). The
// server guide-chat endpoint (t-3 remaining) sends these to the LLM; the client
// dispatches them (guideTools.ts); and the separation-of-concerns guard asserts
// against this list.
//
// THE LOAD-BEARING BOUNDARY (dec-4 / ac-28): the guide deals only in guide
// things. There are NO product-data tools here — no search_memex, no entity
// lookup, no doc reads. The guide knows the product's SHAPE (screens, elements,
// concepts); it never reads the tenant's CONTENT. Asked for an entity by
// description ("take me to the spec about voice") it TEACHES — navigates to the
// list screen and highlights the search affordance — it does not query data.
// The main in-app agent works the data; the guide teaches the product.

import type { GuideScreenKey } from './guide-registry.js';

/** Anthropic-shaped tool definition (the subset the guide needs). */
export interface GuideToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/** The guide's ENTIRE toolset. Adding anything that touches tenant data here
 *  breaks dec-4 — the guard test (guide-tools.test.ts) enforces it. */
export const GUIDE_TOOLS: GuideToolDefinition[] = [
  {
    name: 'highlight',
    description:
      'Visually highlight an element on the CURRENT screen so the user can see what you are explaining. Use the element id from the screen registry you were given.',
    input_schema: {
      type: 'object',
      properties: {
        elementId: { type: 'string', description: 'A registry element id on the current screen.' },
      },
      required: ['elementId'],
    },
  },
  {
    name: 'navigate',
    description:
      'Take the user to another screen of the app. Only registered screen keys are allowed. For a specific entity the user names by description, do NOT try to open it directly — navigate to the relevant list screen and highlight its search affordance so they can find it.',
    input_schema: {
      type: 'object',
      properties: {
        screen: { type: 'string', description: 'A registered, navigable screen key (e.g. specs-list, standards-list).' },
      },
      required: ['screen'],
    },
  },
  {
    name: 'search_guide',
    description:
      'Search the product documentation (how Memex works) for a concept or how-to. This searches GUIDE content only — never the user’s specs, standards, or other tenant data.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look up in the product docs.' },
      },
      required: ['query'],
    },
  },
  // spec-206 t-4 (dec-1): the synced demo walkthrough. A pure UI affordance — it
  // touches NO tenant data (it just moves the on-screen demo board), so it does
  // not breach the dec-4 boundary. The guide calls it once after narrating each
  // phase of the demo-specs walkthrough.
  {
    name: 'advance_demo',
    description:
      'During the demo-specs walkthrough ONLY: advance the on-screen demo board to the next phase (draft → specify → build → verify → done). Call this once right after you finish narrating each phase, so the visible demo spec moves to the next column in sync with what you are saying. Takes no input; it is a no-op once already at the final phase. Never use it outside the walkthrough.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
];

/** The guide tool names as a set (dispatch + guard). */
export const GUIDE_TOOL_NAMES: ReadonlySet<string> = new Set(GUIDE_TOOLS.map((t) => t.name));

// Screens reachable by key ALONE (no entity id). Detail screens (spec-detail,
// standard-detail, document-detail) need an id the guide can't resolve from
// product data (dec-4) — it teaches instead — so they are NOT navigable targets.
// Value = the path suffix after /:namespace/:memex.
const NAVIGABLE_SCREENS: Partial<Record<GuideScreenKey, string>> = {
  'specs-list': 'specs',
  'standards-list': 'standards',
  'drift-inbox': 'drift',
  decisions: 'decisions',
  'issues-list': 'issues',
  pulse: 'pulse',
  insights: 'insights',
  'memex-settings': 'settings',
  'memex-keys': 'keys',
  'scaffold-inspect': 'scaffold',
  'org-config': 'org',
};

export function isNavigableScreen(key: string): key is GuideScreenKey {
  return key in NAVIGABLE_SCREENS;
}

/**
 * Build the router path for a navigable screen, scoped to the current tenant.
 * Returns null if `key` isn't a navigable screen (so navigate rejects without
 * ever calling the router — dec-4 / ac-26). Tenant scope comes from the current
 * route context only, never from product data.
 */
export function screenKeyToPath(
  key: string,
  ctx: { namespace: string; memex: string },
): string | null {
  if (!isNavigableScreen(key)) return null;
  const suffix = NAVIGABLE_SCREENS[key];
  return `/${ctx.namespace}/${ctx.memex}/${suffix}`;
}
