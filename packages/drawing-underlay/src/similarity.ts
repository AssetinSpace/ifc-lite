/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * 2D similarity calibration for drawing underlays.
 *
 * A drawing placement is derived from exactly two point correspondences: two
 * points picked on the drawing (in PDF page coordinates — points, bottom-left
 * origin, y up, i.e. the PDF's own user space, same convention as the
 * `_drawing_links` bboxes) matched to two known model coordinates (IFC model
 * metres, y up). Both frames are y-up, so a *proper* similarity (uniform
 * scale + rotation + translation, no reflection) is fully determined by two
 * distinct pairs — which is exactly why the affine is defined on page points
 * rather than raster pixels: raster pixel coordinates are y-down and tied to
 * one render resolution, so a re-raster at a different DPI would invalidate
 * the calibration.
 *
 * The result is expressed as a general 2×3 affine so downstream code never
 * needs to special-case similarities, and a future 3-point (full affine)
 * calibration can reuse every consumer unchanged.
 */

/** A 2D point. Frame is documented at each use site (page points | IFC metres). */
export interface Point2 {
  x: number;
  y: number;
}

/**
 * Row-major 2×3 affine `[a, b, tx, c, d, ty]`:
 * `x' = a·x + b·y + tx`, `y' = c·x + d·y + ty`.
 */
export type Affine2x3 = readonly [number, number, number, number, number, number];

/** One calibration correspondence: a drawing point matched to a model point. */
export interface CalibrationPair {
  /** Picked point on the drawing, PDF page points (bottom-left origin, y up). */
  page: Point2;
  /** Matching model coordinate, IFC model metres (plan XY, y up). */
  model: Point2;
}

/** Numerical floor below which two calibration points count as coincident. */
const DEGENERATE_DISTANCE = 1e-9;

/** Apply an affine to a point. */
export function applyAffine(m: Affine2x3, p: Point2): Point2 {
  return {
    x: m[0] * p.x + m[1] * p.y + m[2],
    y: m[3] * p.x + m[4] * p.y + m[5],
  };
}

/**
 * Invert a 2×3 affine. Throws on a singular (non-invertible) matrix — a
 * placement whose affine cannot be inverted is corrupt, not a soft case.
 */
export function invertAffine(m: Affine2x3): Affine2x3 {
  const [a, b, tx, c, d, ty] = m;
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < DEGENERATE_DISTANCE) {
    throw new Error(`invertAffine: singular affine (det=${det})`);
  }
  const ia = d / det;
  const ib = -b / det;
  const ic = -c / det;
  const id = a / det;
  return [ia, ib, -(ia * tx + ib * ty), ic, id, -(ic * tx + id * ty)];
}

/**
 * Uniform scale factor of a similarity affine (drawing point → model metre).
 * For a similarity `[s·cosθ, -s·sinθ, tx, s·sinθ, s·cosθ, ty]` this is `s`.
 */
export function similarityScale(m: Affine2x3): number {
  return Math.hypot(m[0], m[3]);
}

/** Rotation angle (radians, CCW) of a similarity affine. */
export function similarityRotation(m: Affine2x3): number {
  return Math.atan2(m[3], m[0]);
}

/** Compose two affines: result applies `a` first, then `b` (b ∘ a). */
export function composeAffine(b: Affine2x3, a: Affine2x3): Affine2x3 {
  return [
    b[0] * a[0] + b[1] * a[3],
    b[0] * a[1] + b[1] * a[4],
    b[0] * a[2] + b[1] * a[5] + b[2],
    b[3] * a[0] + b[4] * a[3],
    b[3] * a[1] + b[4] * a[4],
    b[3] * a[2] + b[4] * a[5] + b[5],
  ];
}

/**
 * Fine-tune a placement affine (page → IFC metres) in MODEL space:
 * translate by metres, rotate by radians and/or scale by a factor about a
 * model-space centre point. Used by numeric nudge controls, so a placed
 * drawing can be adjusted without re-picking calibration points.
 */
export function adjustAffine(
  affine: Affine2x3,
  adjust: {
    /** Translation in IFC metres. */
    translate?: Point2;
    /** CCW rotation in radians about `center`. */
    rotateRad?: number;
    /** Uniform scale factor about `center`. */
    scaleFactor?: number;
    /** Model-space pivot for rotate/scale (default: affine's image of (0,0)). */
    center?: Point2;
  },
): Affine2x3 {
  const c = adjust.center ?? applyAffine(affine, { x: 0, y: 0 });
  let out = affine;
  if (adjust.rotateRad || (adjust.scaleFactor !== undefined && adjust.scaleFactor !== 1)) {
    const s = adjust.scaleFactor ?? 1;
    const cos = Math.cos(adjust.rotateRad ?? 0) * s;
    const sin = Math.sin(adjust.rotateRad ?? 0) * s;
    // T(c) · R·S · T(-c), post-applied in model space.
    const m: Affine2x3 = [
      cos, -sin, c.x - cos * c.x + sin * c.y,
      sin, cos, c.y - sin * c.x - cos * c.y,
    ];
    out = composeAffine(m, out);
  }
  if (adjust.translate) {
    out = [out[0], out[1], out[2] + adjust.translate.x, out[3], out[4], out[5] + adjust.translate.y];
  }
  return out;
}

/**
 * Build the proper similarity from ONE anchor correspondence plus an explicit
 * scale and rotation — the "1 point + scale + angle" calibration. The anchor
 * page point maps exactly onto the anchor model point; `scale` is model
 * metres per PDF page point; `rotationRad` is CCW.
 *
 * Unlike the 2-point solve, nothing is measured: scale typically comes from
 * the drawing's title block (1:N) and rotation is usually 0° (plan drawn
 * parallel to the model axes), so a single unambiguous pivot point fully
 * determines the placement — no angular error amplified by a short pick span.
 */
export function similarityFromAnchor(
  anchor: CalibrationPair,
  scale: number,
  rotationRad: number,
): Affine2x3 {
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(`similarityFromAnchor: scale must be a positive number (got ${scale})`);
  }
  if (!Number.isFinite(rotationRad)) {
    throw new Error(`similarityFromAnchor: rotation must be finite (got ${rotationRad})`);
  }
  const qRe = Math.cos(rotationRad) * scale;
  const qIm = Math.sin(rotationRad) * scale;
  // t = model − q · page (complex multiply), so the anchor maps exactly.
  const tx = anchor.model.x - (qRe * anchor.page.x - qIm * anchor.page.y);
  const ty = anchor.model.y - (qIm * anchor.page.x + qRe * anchor.page.y);
  return [qRe, -qIm, tx, qIm, qRe, ty];
}

/**
 * Solve the proper similarity (uniform scale + rotation + translation) that
 * maps the two `page` points onto the two `model` points exactly.
 *
 * Complex-number formulation: with page points z₁, z₂ and model points w₁, w₂
 * treated as complex numbers, the similarity is `w = q·z + t` where
 * `q = (w₂ − w₁) / (z₂ − z₁)` and `t = w₁ − q·z₁`. `q = s·e^{iθ}` carries the
 * scale and rotation in one step; no trigonometry or normalisation needed.
 *
 * Throws when either point pair is (numerically) coincident — two distinct
 * points in *both* frames are required for the transform to be determined.
 */
export function solveSimilarityFromCalibration(
  pairs: readonly [CalibrationPair, CalibrationPair],
): Affine2x3 {
  const [p1, p2] = pairs;

  const dzx = p2.page.x - p1.page.x;
  const dzy = p2.page.y - p1.page.y;
  const dwx = p2.model.x - p1.model.x;
  const dwy = p2.model.y - p1.model.y;

  const zLen = Math.hypot(dzx, dzy);
  if (zLen < DEGENERATE_DISTANCE) {
    throw new Error('solveSimilarityFromCalibration: drawing points are coincident');
  }
  const wLen = Math.hypot(dwx, dwy);
  if (wLen < DEGENERATE_DISTANCE) {
    throw new Error('solveSimilarityFromCalibration: model points are coincident');
  }

  // q = (w2 - w1) / (z2 - z1), complex division.
  const zLenSq = dzx * dzx + dzy * dzy;
  const qRe = (dwx * dzx + dwy * dzy) / zLenSq;
  const qIm = (dwy * dzx - dwx * dzy) / zLenSq;

  // t = w1 - q * z1
  const tx = p1.model.x - (qRe * p1.page.x - qIm * p1.page.y);
  const ty = p1.model.y - (qIm * p1.page.x + qRe * p1.page.y);

  return [qRe, -qIm, tx, qIm, qRe, ty];
}
