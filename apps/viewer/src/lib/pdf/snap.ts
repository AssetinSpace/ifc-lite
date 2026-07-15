/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Magnetic snapping for calibration picks on a rasterized drawing (D-072).
 *
 * Technical drawings are dark linework on a light page, so a lightweight
 * image heuristic gives a reliable "magnet" without extracting PDF vector
 * geometry: within a small search radius around the click, score every
 * sufficiently dark pixel by
 *
 *   darkness  +  junction bonus  −  distance penalty
 *
 * where the junction bonus counts how many of the 8 compass arms around the
 * pixel are also dark a few pixels out — line interiors score 2 arms, corners
 * ~2 (bent), T-junctions 3, crossings 4 — so intersections win over plain
 * line points, which win over blank paper. Returns null when nothing dark
 * enough is nearby (click on empty paper stays exactly where it was).
 */

export interface SnapResult {
  x: number;
  y: number;
  /** True when the winning pixel had ≥3 dark arms (a junction/corner). */
  junction: boolean;
}

/** Arm probe offsets (8 directions), sampled at this many pixels out. */
const ARM_DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];
const ARM_STEP = 3;
/** Pixels darker than this (0..255 luma) count as linework. */
const DARK_LUMA = 160;

export function snapToDrawingFeature(
  canvas: HTMLCanvasElement,
  rasterX: number,
  rasterY: number,
  radius = 18,
): SnapResult | null {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;

  const x0 = Math.max(0, Math.round(rasterX - radius));
  const y0 = Math.max(0, Math.round(rasterY - radius));
  const x1 = Math.min(canvas.width - 1, Math.round(rasterX + radius));
  const y1 = Math.min(canvas.height - 1, Math.round(rasterY + radius));
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  if (w < 3 || h < 3) return null;

  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(x0, y0, w, h).data;
  } catch {
    return null; // tainted canvas etc. — no snap, keep the raw click
  }

  const luma = (ix: number, iy: number): number => {
    const o = (iy * w + ix) * 4;
    // Weighted luma; PDFs are usually grayscale linework anyway.
    return 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
  };

  let best: { score: number; ix: number; iy: number; arms: number } | null = null;
  for (let iy = 0; iy < h; iy++) {
    for (let ix = 0; ix < w; ix++) {
      const v = luma(ix, iy);
      if (v > DARK_LUMA) continue;
      let arms = 0;
      for (const [dx, dy] of ARM_DIRS) {
        const ax = ix + dx * ARM_STEP;
        const ay = iy + dy * ARM_STEP;
        if (ax < 0 || ay < 0 || ax >= w || ay >= h) continue;
        if (luma(ax, ay) <= DARK_LUMA) arms++;
      }
      const dist = Math.hypot(ix + x0 - rasterX, iy + y0 - rasterY);
      const score = (255 - v) + arms * 70 - dist * 9;
      if (!best || score > best.score) best = { score, ix, iy, arms };
    }
  }

  if (!best) return null;
  return { x: best.ix + x0, y: best.iy + y0, junction: best.arms >= 3 };
}
