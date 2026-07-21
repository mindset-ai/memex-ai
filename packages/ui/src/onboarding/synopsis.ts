// spec-502 t-2 (dec-7, ac-18): the Explore companion's synopsis builder.
//
// `deriveSynopsis(entity)` turns whatever entity the user is currently looking at
// inside a Memex into a short, human synopsis — a headline + one or two sentences.
// It is deliberately:
//   - PURE + DETERMINISTIC: same entity in ⇒ same synopsis out. No LLM call, no
//     clock, no randomness (dec-7 rejected the metered-LLM option: latency, cost,
//     non-determinism for a surface whose whole job is "reflect what's on screen").
//   - PORTABLE (std-22): it reads only GENERIC entity fields and describes each
//     kind in the product's own vocabulary (Spec / Standard / Decision …). Nothing
//     about `building-itself` or any specific Memex is hardcoded, so the companion
//     reads sensibly over ANY Memex a user explores.
//   - SWAPPABLE: callers depend on this one function. A future data-backed synopsis
//     (real doc titles/summaries) can implement the same signature without touching
//     the companion's reactivity — the fields are already here.
//
// Every surface a user can be on maps to a DISTINCT kind, so the companion says
// something specific on every screen — a board is not the same as "an item".

/** The kinds of thing a user can be "looking at" within a Memex. Generic across
 *  any Memex — these are the product's primitives + its navigable surfaces, not
 *  one workspace's content. Detail entities carry a handle; board/surface kinds
 *  describe the screen itself. */
export type SynopsisEntityKind =
  // ── focused entities (a single thing, usually with a handle) ──
  | 'spec'
  | 'doc'
  | 'standard'
  | 'skill'
  | 'section'
  | 'decision'
  | 'issue'
  | 'task'
  // ── board / list / tool surfaces (the whole screen is the subject) ──
  | 'specs-board'
  | 'standards-board'
  | 'docs-board'
  | 'skills-board'
  | 'decisions-board'
  | 'issues-board'
  | 'tags'
  | 'drift'
  | 'pulse'
  | 'insights'
  | 'qa-reports'
  | 'settings'
  | 'keys'
  | 'scaffold'
  | 'org'
  // ── the whole-vault graph + overview ──
  | 'trail'
  | 'home'
  // ── nothing we can name ──
  | 'unknown';

/** The in-view entity, described by its OWN structured fields. Every field beyond
 *  `kind` is optional: the companion degrades gracefully when the route tells us
 *  the kind + handle but nothing richer is loaded yet. */
export interface SynopsisEntity {
  readonly kind: SynopsisEntityKind;
  /** Canonical handle, e.g. `spec-482`, `std-28`, `dec-3`. */
  readonly handle?: string;
  /** Human title, when known. */
  readonly title?: string;
  /** A one-line description / summary, when the entity carries one. */
  readonly summary?: string;
  /** Lifecycle/status label, e.g. `build`, `active`, `resolved`. */
  readonly status?: string;
  /** Salient related handles (links), most-relevant first. */
  readonly links?: readonly string[];
}

/** The rendered synopsis: a short headline + a one-or-two-sentence body, plus a
 *  screen-specific value hook that motivates the standing "Create your own Memex"
 *  CTA ("you could have this too"). Portable — never names a specific workspace. */
export interface Synopsis {
  readonly headline: string;
  readonly body: string;
  readonly nudge: string;
}

/** Human label — the noun shown to the user. For a focused entity it prefixes the
 *  handle ("Spec spec-482"); for a board/surface it IS the headline ("Specs"). */
const KIND_LABEL: Record<SynopsisEntityKind, string> = {
  spec: 'Spec',
  doc: 'Document',
  standard: 'Standard',
  skill: 'Skill',
  section: 'Section',
  decision: 'Decision',
  issue: 'Issue',
  task: 'Task',
  'specs-board': 'Specs',
  'standards-board': 'Standards',
  'docs-board': 'Documents',
  'skills-board': 'Skills',
  'decisions-board': 'Decisions',
  'issues-board': 'Issues',
  tags: 'Tags',
  drift: 'Drift',
  pulse: 'Pulse',
  insights: 'Insights',
  'qa-reports': 'QA Reports',
  settings: 'Settings',
  keys: 'Keys',
  scaffold: 'Scaffold',
  org: 'Organization',
  trail: 'Trails',
  home: 'Overview',
  unknown: 'Item',
};

// A generic, portable gloss for what each thing IS — the product's own vocabulary,
// true for ANY Memex (std-22). Written as a complete sentence; used whenever the
// entity carries no summary of its own. Board/surface glosses describe the screen.
const KIND_GLOSS: Record<SynopsisEntityKind, string> = {
  spec: 'A living document that captures the why behind a change — its decisions, tasks, and acceptance criteria.',
  doc: 'A reference document in this workspace.',
  standard: 'A durable rule the work is held to.',
  skill: 'A reusable, portable instruction set an agent can follow.',
  section: 'One part of a larger document.',
  decision: 'A resolved choice that shapes how the work gets built.',
  issue: 'A loose end that fell out of a Spec — tracked until it is folded back in.',
  task: 'A concrete unit of work handed to a coding agent.',
  'specs-board': 'Every unit of work here — each one a Spec carrying its own decisions, tasks, and acceptance criteria.',
  'standards-board': 'The durable, locked rules this workspace holds its work to.',
  'docs-board': 'The free-form reference documents and plans in this workspace.',
  'skills-board': 'The reusable, portable instruction sets an agent can follow here.',
  'decisions-board': 'Every resolved choice that has shaped how the work gets built.',
  'issues-board': 'The open loose ends across every Spec, grouped under the Spec that owns them.',
  tags: "The labels that organise this workspace's Specs.",
  drift: 'Where the docs and the code have fallen out of sync — the workspace flags it here.',
  pulse: 'The activity feed — what has changed across the workspace, and when.',
  insights: 'Analytics over the Specs in this workspace.',
  'qa-reports': 'The feed of build-session QA reports, one per session.',
  settings: 'How this Memex is configured.',
  keys: 'The emission keys that let your tests report acceptance-criteria results here.',
  scaffold: 'The agent scaffold — the prompts and prose that steer coding agents in this workspace.',
  org: 'The people and access around this workspace.',
  trail: 'The interconnected knowledge graph of this whole workspace.',
  home: 'The workspace overview — where a Memex opens.',
  unknown: 'Part of this workspace.',
};

// The screen-specific value hook shown just above the CTA — "you could have this
// too". Ties whatever the user is looking at to the reason to create their own
// Memex, so the standing button isn't motivation-free. Generic/portable (std-22).
const KIND_NUDGE: Record<SynopsisEntityKind, string> = {
  spec: 'Track your own work as Specs like this.',
  doc: 'Keep living docs like this.',
  standard: 'Hold your own work to Standards like this.',
  skill: 'Give your agents Skills like this.',
  section: 'Build documents like this.',
  decision: 'Capture your own decisions like this.',
  issue: 'Never lose a loose end like this.',
  task: 'Hand your agent work like this.',
  'specs-board': 'Track your own work as Specs like these.',
  'standards-board': 'Hold your own work to Standards like these.',
  'docs-board': 'Keep living docs like these.',
  'skills-board': 'Give your agents Skills like these.',
  'decisions-board': 'Capture your own decisions like these.',
  'issues-board': 'Never lose a loose end like these.',
  tags: 'Organise your own work like this.',
  drift: 'Catch doc-vs-code drift like this.',
  pulse: 'See your own activity like this.',
  insights: 'Get analytics like these on your own work.',
  'qa-reports': 'Get build-session QA reports like these.',
  settings: 'Run your own workspace like this.',
  keys: 'Wire your own tests to a board like this.',
  scaffold: 'Steer your own agents with a scaffold like this.',
  org: 'Bring your own team into a workspace like this.',
  trail: 'Grow a knowledge graph like this.',
  home: 'Open a workspace like this.',
  unknown: 'Build a workspace like this.',
};

const MAX_LINKS = 3;

function clean(value: string | undefined): string {
  return (value ?? '').trim();
}

/**
 * Compose a short synopsis of the in-view entity from its own structured fields.
 * Deterministic and side-effect-free.
 */
export function deriveSynopsis(entity: SynopsisEntity): Synopsis {
  const label = KIND_LABEL[entity.kind] ?? KIND_LABEL.unknown;
  const gloss = KIND_GLOSS[entity.kind] ?? KIND_GLOSS.unknown;
  const handle = clean(entity.handle);
  const title = clean(entity.title);
  const summary = clean(entity.summary);
  const status = clean(entity.status);
  const links = (entity.links ?? []).map((l) => clean(l)).filter(Boolean);

  // "Spec spec-482" when there's a handle, else just the label ("Specs").
  const idBit = handle ? `${label} ${handle}` : label;

  // Headline: the most specific name we have — a real title, else the id/label.
  const headline = title || idBit;

  const sentences: string[] = [];
  if (summary) {
    // The entity describes itself — lead with that, prefixed so the KIND is clear.
    sentences.push(`${idBit}: ${summary}`);
  } else {
    // No summary loaded — the generic, per-kind gloss. The headline already names
    // the thing, so the body is just what that kind of thing IS.
    sentences.push(gloss);
  }
  if (status) sentences.push(`Currently ${status}.`);
  if (links.length) sentences.push(`Related: ${links.slice(0, MAX_LINKS).join(', ')}.`);

  const nudge = KIND_NUDGE[entity.kind] ?? KIND_NUDGE.unknown;

  return { headline, body: sentences.join(' '), nudge };
}
