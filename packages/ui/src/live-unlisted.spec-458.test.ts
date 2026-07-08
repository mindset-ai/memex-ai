// spec-458 t-4 — the UNLISTED posture (dec-4, ac-8/ac-12).
//
// /live is reachable only by direct URL: no anchor, Link, or navigate() target
// anywhere in the UI source may point at it, and the page itself must carry the
// noindex directive. Source-scan regression (the shape ac-12 sanctions): a new
// nav item or footer link to /live fails this test at PR time.

import { describe, it, expect } from 'vitest';
import { tagAc } from '@memex-ai-ac/vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const AC = 'mindset-prod/memex-building-itself/specs/spec-458/acs';
// vitest runs with cwd = packages/ui (jsdom env mangles import.meta.url).
const SRC = join(process.cwd(), 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      walk(p, out);
    } else if (/\.(tsx?|jsx?)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

// Link-shaped references to /live: href/to/navigate targets. Deliberately does
// NOT match the App.tsx route REGISTRATION (path="/live") — the route must
// exist; links to it must not.
const LINK_SHAPES = [
  /href=["'`]\/live["'`?]/,
  /\bto=["'`]\/live["'`?]/,
  /navigate\(\s*["'`]\/live["'`?]/,
  /Navigate to=["'`]\/live["'`?]/,
];

describe('unlisted /live (dec-4)', () => {
  it('no anchor, Link, or navigate target points at /live anywhere outside the page itself', () => {
    tagAc(`${AC}/ac-8`);
    tagAc(`${AC}/ac-12`);
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(SRC, file);
      if (rel.startsWith(join('pages', 'live')) || rel === 'live-unlisted.spec-458.test.ts') {
        continue;
      }
      const content = readFileSync(file, 'utf8');
      if (LINK_SHAPES.some((re) => re.test(content))) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it('the live page injects the robots noindex directive', () => {
    tagAc(`${AC}/ac-12`);
    const page = readFileSync(join(SRC, 'pages/live/LivePage.tsx'), 'utf8');
    expect(page).toContain("meta.name = 'robots'");
    expect(page).toContain("meta.content = 'noindex'");
  });

  it('the map renders from the checked-in dot asset — no map/tile/globe/WebGL dependency (ac-14)', () => {
    tagAc(`${AC}/ac-14`);
    const pkg = JSON.parse(readFileSync(join(SRC, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const forbidden = deps.filter((d) =>
      /three|mapbox|maplibre|leaflet|openlayers|cesium|globe|d3-geo/i.test(d),
    );
    expect(forbidden).toEqual([]);
    // The map's only geometry source is the checked-in Natural Earth asset.
    const page = readFileSync(join(SRC, 'pages/live/LivePage.tsx'), 'utf8');
    expect(page).toContain("from './worldDots'");
    expect(page).toContain('<svg');
  });

  it('no sitemap in the ui package references /live (or exists at all)', () => {
    tagAc(`${AC}/ac-8`);
    const uiRoot = join(SRC, '..');
    const candidates: string[] = [];
    for (const name of readdirSync(join(uiRoot, 'public'))) {
      if (/sitemap/i.test(name)) candidates.push(name);
    }
    expect(candidates).toEqual([]);
  });
});
