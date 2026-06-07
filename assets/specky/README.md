# Specky — the voice guide's face (spec-197)

**Specky** is an original animated-paperclip character (in the spirit of
Microsoft's Clippy, but **original artwork** — no licensing concern). It is the
visual identity for the spec-190 voice guide: the small in-view entry affordance
and the avatar shown in the live session pill.

This directory is the **canonical source of truth** for the Specky assets.

## Files

| File | Role |
|---|---|
| `specky.svg` | **Primary deliverable.** Self-contained animated SVG — transparent background, crisp at any size, idle loop defined entirely in its `<style>` block. This is the asset the web app uses. |
| `make_raster.py` | Regenerates the raster fallbacks (`specky.gif`, `specky.png`) from `specky.svg`. |
| `specky.gif` / `specky.png` | *(optional)* Raster fallbacks for non-web surfaces that can't run SVG (e.g. email). Regenerate with `make_raster.py`. Not required by the web app. |

## The served copy

The web app loads Specky from **`packages/ui/src/assets/specky.svg`**, imported
as a bundler asset:

```ts
import speckyUrl from './assets/specky.svg';   // Vite emits /assets/specky-<hash>.svg
// <img src={speckyUrl} alt="" />
```

That file is a **byte-identical copy** of the `specky.svg` in this directory —
this dir is the source of truth. When you change `specky.svg` here, sync the
copy:

```bash
cp assets/specky/specky.svg packages/ui/src/assets/specky.svg
```

A tagged test (`packages/ui/src/specky-asset.spec-197.test.ts`) fails loudly if
the two drift apart.

### Why not `packages/ui/public/specky.svg` (a web-root file)?

The int/prod load-balancer url-map (`spa-matcher`) only routes an **explicit
allowlist** of web-root paths to the static bucket (`/favicon.svg`,
`/favicon.ico`, `/robots.txt`, plus `/assets/*`). Any other root path —
including `/specky.svg` — falls through to the priority-100 catch-all, which
rewrites to `/index.html` and serves the SPA shell (a 404 for the asset).
`favicon.svg` works only because it has its *own* bespoke route, **not** because
web-root files are generically served. Importing Specky as a bundler asset puts
it under the already-routed `/assets/` prefix with immutable caching and **no
url-map change** — and it works identically on int and prod (spec-197 dec-3,
revised 2026-06-07).

## Animation

The idle loop lives entirely in the SVG's `<style>` block and runs automatically
when embedded as an `<img>` — no JavaScript, no animation runtime (spec-197
dec-3 = drop-in static SVG, **not** Lottie/inline-component):

- `wobble` (7s) — gentle lean
- `look` + `brows` (9s) — glance left ↔ right
- `blink` (6.5s)
- ~9s overall idle loop

Tweak fidgetiness by changing those durations.

### Reduced motion

Per spec-197 **dec-5(b)**, the SVG carries a
`@media (prefers-reduced-motion: reduce)` rule that sets `animation: none`,
freezing Specky to a neutral static frame. It is **never** `display:none` — the
affordance stays discoverable for motion-sensitive users. Because the rule lives
inside the SVG, the asset self-handles reduced motion even when embedded as a
plain `<img>`, with no consuming-component CSS required.

## Provenance

Delivered by Barrie Hadfield via Slack DM on **2026-06-07** as `clippy.zip` (the
delivery filename predates the **Specky** name; "Clippy" survives only as the
historical inspiration). The full SVG source is also captured verbatim in
spec-197 §s-2 (`https://memex.ai/mindset-prod/memex-building-itself/specs/spec-197`)
so it survives independent of Slack.

> **Note on `make_raster.py`:** the script in this directory is an in-repo
> regenerator authored to reproduce the delivered raster fallbacks from
> `specky.svg`. If you prefer Barrie's original from `clippy.zip`, drop it in
> here to replace this one — the contract (`specky.svg` → `specky.gif` +
> `specky.png`) is the same.
