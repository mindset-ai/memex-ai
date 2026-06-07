// spec-190 t-4 / dec-3: the screen-element registry — the referential backbone
// binding guide content (t-6/t-7) and the guide's highlight/navigate tools (t-5)
// to the UI. A SIBLING of the Scaffold (scaffold-data.ts), mirroring its
// conventions (typed nodes, stable kebab-case string ids, `rationale` cites for
// durability per std-15/std-16) without living inside it: the Scaffold is agent
// prompting; this is screen anatomy.
//
// - SCREEN KEYS: a canonical enumeration of stable per-screen keys.
// - ROUTE MAPPING: resolveScreenKey(pathname) derives the current screenKey from
//   the router so the guide graph (dec-1) can keep screenKey in state.
// - ELEMENTS: per-screen { id, description } entries. `description` is the
//   human-readable account the agent reads to decide what to highlight. The
//   matching DOM nodes carry `data-guide-id="<id>"`; the highlight tool (t-5)
//   resolves id → node at runtime (see packages/ui/src/voice/guideElements.ts).
//
// The server imports this at guide-content import time (t-7) to validate that
// markdown frontmatter references only real screen keys and element ids.

/** Canonical stable keys for the app's user-facing screens. */
// The full set of screen keys, as a runtime value. GuideScreenKey is DERIVED
// from it (below) so the type and the runtime list can never drift — the t-7
// import validator (isKnownScreenKey) and any UI iteration share one source.
export const GUIDE_SCREEN_KEYS = [
  'specs-list',
  'spec-detail',
  'standards-list',
  'standard-detail',
  'drift-inbox',
  'document-detail',
  'decisions',
  'issues-list',
  'pulse',
  'insights',
  'memex-settings',
  'memex-keys',
  'org-config',
  'scaffold-inspect',
] as const;

export type GuideScreenKey = (typeof GUIDE_SCREEN_KEYS)[number];

/** True when `key` is a known screen key (t-7 frontmatter validation). */
export function isKnownScreenKey(key: string): key is GuideScreenKey {
  return (GUIDE_SCREEN_KEYS as readonly string[]).includes(key);
}

export interface GuideElement {
  /** Stable kebab-case id; the matching DOM node carries data-guide-id="<id>". */
  id: string;
  /** Human-readable account of what the element is/does (the agent reads this). */
  description: string;
}

export interface GuideScreen {
  key: GuideScreenKey;
  /** Human label for the screen. */
  title: string;
  /** Highlightable elements on this screen. */
  elements: GuideElement[];
  /** Source cite for durability (std-15/std-16). */
  rationale: string;
}

interface RoutePattern {
  /** Tested against the in-memex subpath (after `/:namespace/:memex`). */
  test: RegExp;
  screenKey: GuideScreenKey;
}

// Ordered most-specific-first. Patterns match the subpath AFTER the
// /:namespace/:memex prefix (e.g. "/specs/spec-12" → "/specs/spec-12").
const ROUTE_PATTERNS: RoutePattern[] = [
  { test: /^\/specs\/[^/]+/, screenKey: 'spec-detail' },
  { test: /^\/specs\/?$/, screenKey: 'specs-list' },
  { test: /^\/standards\/[^/]+/, screenKey: 'standard-detail' },
  { test: /^\/standards\/?$/, screenKey: 'standards-list' },
  { test: /^\/drift\/?$/, screenKey: 'drift-inbox' },
  { test: /^\/docs\/[^/]+/, screenKey: 'document-detail' },
  { test: /^\/decisions\/?$/, screenKey: 'decisions' },
  { test: /^\/issues\/?$/, screenKey: 'issues-list' },
  { test: /^\/pulse\/?$/, screenKey: 'pulse' },
  { test: /^\/insights\/?$/, screenKey: 'insights' },
  { test: /^\/settings\/?$/, screenKey: 'memex-settings' },
  { test: /^\/keys\/?$/, screenKey: 'memex-keys' },
  { test: /^\/scaffold\/?$/, screenKey: 'scaffold-inspect' },
  { test: /^\/org\/?$/, screenKey: 'org-config' },
  { test: /^\/?$/, screenKey: 'specs-list' }, // index (/:ns/:mx) → the Specs board
];

/**
 * Derive the current screen key from a router pathname. Returns null when the
 * path isn't a tenancy-scoped screen (`/<namespace>/<memex>/...`) or doesn't map
 * to a known screen. Pure — no DOM, usable on server (content validation) and
 * client (graph state).
 */
export function resolveScreenKey(pathname: string): GuideScreenKey | null {
  const segs = pathname.replace(/^\/+/, '').replace(/\/+$/, '').split('/');
  if (segs.length < 2) return null; // need at least <namespace>/<memex>
  const sub = '/' + segs.slice(2).join('/');
  for (const p of ROUTE_PATTERNS) {
    if (p.test.test(sub)) return p.screenKey;
  }
  return null;
}

// Element entries. Seeded for the onboarding-central screens first (dec-3 / the
// t-4 exploration recommendation): specs-list, spec-detail, standards-list. Other
// screens get entries as guide content is authored for them (dec-7) — the union
// of keys above is the full surface; this map grows screen-by-screen.
export const GUIDE_SCREENS: Partial<Record<GuideScreenKey, GuideScreen>> = {
  'specs-list': {
    key: 'specs-list',
    title: 'Specs board',
    rationale: 'spec-190 dec-3 / t-4: the Kanban board is every new user’s entry point.',
    elements: [
      { id: 'new-spec-button', description: 'Button that creates a new Spec.' },
      { id: 'spec-card', description: 'A draggable Spec card showing title, assignees, phase, and AC health.' },
      { id: 'spec-card-health', description: 'The AC-health strip/pill on a card (green vs red acceptance criteria).' },
      { id: 'phase-columns', description: 'The phase columns (draft / specify / build / verify) the board is organised into.' },
      { id: 'search-trigger', description: 'The ⌘K search trigger that opens the command palette to jump to any Spec.' },
    ],
  },
  'spec-detail': {
    key: 'spec-detail',
    title: 'Spec detail',
    rationale: 'spec-190 dec-3 / t-4: where users spend most time — read narrative, resolve decisions, verify ACs.',
    elements: [
      { id: 'phase-pill', description: 'Shows the Spec’s current phase (draft / specify / build / verify / done).' },
      { id: 'phase-transition-button', description: 'Advances the Spec to the next phase.' },
      { id: 'decisions-panel', description: 'Panel listing the Spec’s decisions (candidate / open / resolved).' },
      { id: 'tasks-panel', description: 'Panel listing tasks (first-class in the build phase).' },
      { id: 'acs-panel', description: 'Panel listing acceptance criteria with their verification state.' },
      { id: 'chat-panel', description: 'The in-app agent chat for collaborating on this Spec.' },
      { id: 'share-button', description: 'Shares the Spec with teammates or externally.' },
    ],
  },
  'standards-list': {
    key: 'standards-list',
    title: 'Standards',
    rationale: 'spec-190 dec-3 / t-4: standards are the team’s rules; the entry point for understanding drift.',
    elements: [
      { id: 'standards-search', description: 'Search/filter standards by title or handle.' },
      { id: 'standards-view-toggle', description: 'Switches between the list and map views of standards.' },
      { id: 'standard-card', description: 'A standard in the list, with its drift badge and last-updated date.' },
    ],
  },
};

/** Screens that currently have registered elements (a subset of all keys). */
export const REGISTERED_SCREEN_KEYS = Object.keys(GUIDE_SCREENS) as GuideScreenKey[];

/** The highlightable elements for a screen ([] when none are registered yet). */
export function guideElementsForScreen(key: GuideScreenKey): GuideElement[] {
  return GUIDE_SCREENS[key]?.elements ?? [];
}

/** True when `id` is a registered element id on `screenKey` (content validation,
 *  t-7, and the highlight tool's guardrail, t-5). */
export function isKnownGuideElement(screenKey: GuideScreenKey, id: string): boolean {
  return guideElementsForScreen(screenKey).some((e) => e.id === id);
}

/** Every registered element id across all screens (used by the t-7 import-time
 *  referential validation and ui-side consistency checks). */
export function allGuideElementIds(): string[] {
  return Object.values(GUIDE_SCREENS).flatMap((s) => s?.elements.map((e) => e.id) ?? []);
}
