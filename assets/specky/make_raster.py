#!/usr/bin/env python3
"""Regenerate Specky's raster fallbacks (specky.gif, specky.png) from specky.svg.

spec-197 dec-4 / ac-5 — the rasters are reproducible from the canonical SVG.

The idle loop is a CSS animation, so faithfully rasterising it needs a real
browser engine: we load specky.svg in Chromium (via Playwright), freeze the
animation at evenly-spaced offsets across the loop, screenshot each frame, and
assemble them into an animated GIF and an APNG with Pillow.

The sub-animations have coprime periods (wobble 7s, look/brows 9s, blink 6.5s),
so a single short loop can't be perfectly seamless; LOOP_SECONDS samples the
~9s idle window Barrie tuned the asset around — good enough for a fallback that
only renders where SVG can't (e.g. email). The web app always uses specky.svg.

Usage:
    pip install playwright pillow && playwright install chromium
    python assets/specky/make_raster.py            # writes specky.gif + specky.png
    python assets/specky/make_raster.py --size 480 --fps 25
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SVG = HERE / "specky.svg"

LOOP_SECONDS = 9.0          # idle window to sample
DEFAULT_FPS = 20
DEFAULT_SIZE = 240          # px width of the rendered raster (SVG is 240x330)


def _require(mod: str, pip_name: str | None = None):
    try:
        return __import__(mod)
    except ImportError:
        name = pip_name or mod
        sys.exit(
            f"error: '{mod}' is required. Install with:\n"
            f"    pip install playwright pillow && playwright install chromium\n"
            f"(missing: {name})"
        )


def capture_frames(size: int, fps: int):
    """Return a list of PIL.Image RGBA frames sampled across the idle loop."""
    _require("playwright")
    from playwright.sync_api import sync_playwright  # type: ignore
    from PIL import Image  # type: ignore
    import io

    svg_markup = SVG.read_text(encoding="utf-8")
    n_frames = max(1, int(round(LOOP_SECONDS * fps)))
    height = int(round(size * 330 / 240))
    frames = []

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": size, "height": height},
                                device_scale_factor=2)
        # Transparent page so the SVG's own transparency is preserved.
        page.set_content(
            f'<body style="margin:0;background:transparent">'
            f'<div id="stage" style="width:{size}px;height:{height}px">{svg_markup}</div>'
            f'</body>'
        )
        for i in range(n_frames):
            offset = (i / n_frames) * LOOP_SECONDS
            # Freeze every animated element at this point in its timeline.
            page.add_style_tag(content=(
                f"#stage * {{"
                f"  animation-delay: -{offset:.4f}s !important;"
                f"  animation-play-state: paused !important;"
                f"}}"
            ))
            png_bytes = page.locator("#stage").screenshot(omit_background=True)
            frames.append(Image.open(io.BytesIO(png_bytes)).convert("RGBA"))
        browser.close()
    return frames


def main() -> None:
    ap = argparse.ArgumentParser(description="Regenerate Specky raster fallbacks from specky.svg")
    ap.add_argument("--size", type=int, default=DEFAULT_SIZE, help="raster width in px")
    ap.add_argument("--fps", type=int, default=DEFAULT_FPS, help="frames per second")
    args = ap.parse_args()

    if not SVG.exists():
        sys.exit(f"error: {SVG} not found")

    _require("PIL", "pillow")
    frames = capture_frames(args.size, args.fps)
    duration_ms = int(round(1000 / args.fps))

    gif_path = HERE / "specky.gif"
    png_path = HERE / "specky.png"

    frames[0].save(
        gif_path, save_all=True, append_images=frames[1:],
        duration=duration_ms, loop=0, disposal=2, transparency=0,
    )
    frames[0].save(
        png_path, save_all=True, append_images=frames[1:],
        duration=duration_ms, loop=0,
    )
    print(f"wrote {gif_path.name} and {png_path.name} ({len(frames)} frames @ {args.fps}fps)")


if __name__ == "__main__":
    main()
