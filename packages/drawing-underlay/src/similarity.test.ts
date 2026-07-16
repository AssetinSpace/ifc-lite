/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import {
  adjustAffine,
  applyAffine,
  composeAffine,
  invertAffine,
  similarityFromAnchor,
  similarityRotation,
  similarityScale,
  solveSimilarityFromCalibration,
  type Affine2x3,
  type CalibrationPair,
  type Point2,
} from './similarity.js';

function expectPointClose(actual: Point2, expected: Point2, digits = 9) {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
}

function pair(page: Point2, model: Point2): CalibrationPair {
  return { page, model };
}

describe('solveSimilarityFromCalibration', () => {
  it('solves the identity from two identical correspondences', () => {
    const m = solveSimilarityFromCalibration([
      pair({ x: 0, y: 0 }, { x: 0, y: 0 }),
      pair({ x: 10, y: 5 }, { x: 10, y: 5 }),
    ]);
    expect(similarityScale(m)).toBeCloseTo(1);
    expect(similarityRotation(m)).toBeCloseTo(0);
    expectPointClose(applyAffine(m, { x: -3, y: 7 }), { x: -3, y: 7 });
  });

  it('solves a pure translation', () => {
    const m = solveSimilarityFromCalibration([
      pair({ x: 0, y: 0 }, { x: 100, y: -50 }),
      pair({ x: 20, y: 0 }, { x: 120, y: -50 }),
    ]);
    expect(similarityScale(m)).toBeCloseTo(1);
    expect(similarityRotation(m)).toBeCloseTo(0);
    expectPointClose(applyAffine(m, { x: 5, y: 5 }), { x: 105, y: -45 });
  });

  it('solves a pure uniform scale (typical drawing-scale case)', () => {
    // 1:50 floor plan: 1 page unit = 0.017638... m if points, but keep it simple:
    // 100 page points span 5 model metres → s = 0.05.
    const m = solveSimilarityFromCalibration([
      pair({ x: 0, y: 0 }, { x: 0, y: 0 }),
      pair({ x: 100, y: 0 }, { x: 5, y: 0 }),
    ]);
    expect(similarityScale(m)).toBeCloseTo(0.05);
    expect(similarityRotation(m)).toBeCloseTo(0);
    expectPointClose(applyAffine(m, { x: 0, y: 100 }), { x: 0, y: 5 });
  });

  it('solves a 90° CCW rotation', () => {
    const m = solveSimilarityFromCalibration([
      pair({ x: 0, y: 0 }, { x: 0, y: 0 }),
      pair({ x: 1, y: 0 }, { x: 0, y: 1 }),
    ]);
    expect(similarityScale(m)).toBeCloseTo(1);
    expect(similarityRotation(m)).toBeCloseTo(Math.PI / 2);
    // A y-up unit vector must land on -x (proper rotation, no reflection).
    expectPointClose(applyAffine(m, { x: 0, y: 1 }), { x: -1, y: 0 });
  });

  it('solves a combined scale + rotation + translation and maps both anchors exactly', () => {
    // Ground truth: s = 2, θ = 30°, t = (7, -3).
    const s = 2;
    const th = Math.PI / 6;
    const truth: Affine2x3 = [
      s * Math.cos(th), -s * Math.sin(th), 7,
      s * Math.sin(th), s * Math.cos(th), -3,
    ];
    const p1: Point2 = { x: 12.5, y: 300.25 };
    const p2: Point2 = { x: 590, y: 41.5 };
    const pairs: [CalibrationPair, CalibrationPair] = [
      pair(p1, applyAffine(truth, p1)),
      pair(p2, applyAffine(truth, p2)),
    ];

    const m = solveSimilarityFromCalibration(pairs);
    for (let i = 0; i < 6; i++) expect(m[i]).toBeCloseTo(truth[i], 9);

    // Both calibration anchors reproduce exactly...
    expectPointClose(applyAffine(m, p1), pairs[0].model);
    expectPointClose(applyAffine(m, p2), pairs[1].model);
    // ...and so does an independent third point (the transform, not just the fit).
    const p3: Point2 = { x: -40, y: 833 };
    expectPointClose(applyAffine(m, p3), applyAffine(truth, p3));
  });

  it('never produces a reflection (det stays positive)', () => {
    const m = solveSimilarityFromCalibration([
      pair({ x: 3, y: 4 }, { x: -20, y: 11 }),
      pair({ x: 87, y: -2 }, { x: -3.5, y: 40 }),
    ]);
    const det = m[0] * m[4] - m[1] * m[3];
    expect(det).toBeGreaterThan(0);
  });

  it('throws on coincident drawing points', () => {
    expect(() =>
      solveSimilarityFromCalibration([
        pair({ x: 5, y: 5 }, { x: 0, y: 0 }),
        pair({ x: 5, y: 5 }, { x: 10, y: 0 }),
      ]),
    ).toThrow(/drawing points/);
  });

  it('throws on coincident model points', () => {
    expect(() =>
      solveSimilarityFromCalibration([
        pair({ x: 0, y: 0 }, { x: 4, y: 4 }),
        pair({ x: 10, y: 0 }, { x: 4, y: 4 }),
      ]),
    ).toThrow(/model points/);
  });
});

describe('composeAffine / adjustAffine', () => {
  const base: Affine2x3 = [0.05, 0, 2, 0, 0.05, 3]; // 1:20-ish plan at (2,3)

  it('composeAffine applies right-hand side first', () => {
    const translate: Affine2x3 = [1, 0, 10, 0, 1, -5];
    const composed = composeAffine(translate, base);
    expectPointClose(applyAffine(composed, { x: 0, y: 0 }), { x: 12, y: -2 });
    expectPointClose(
      applyAffine(composed, { x: 100, y: 0 }),
      { x: applyAffine(base, { x: 100, y: 0 }).x + 10, y: -2 },
    );
  });

  it('adjustAffine translate shifts the placement in model metres', () => {
    const moved = adjustAffine(base, { translate: { x: 0.5, y: -0.25 } });
    expectPointClose(applyAffine(moved, { x: 40, y: 40 }), {
      x: applyAffine(base, { x: 40, y: 40 }).x + 0.5,
      y: applyAffine(base, { x: 40, y: 40 }).y - 0.25,
    });
  });

  it('adjustAffine rotates about the given model-space centre (pivot fixed)', () => {
    const c = applyAffine(base, { x: 50, y: 50 });
    const rot = adjustAffine(base, { rotateRad: Math.PI / 2, center: c });
    // The pivot's page preimage still maps to the pivot.
    expectPointClose(applyAffine(rot, { x: 50, y: 50 }), c);
    // A point 1 page-unit right of the pivot swings 90° CCW: offset (s,0)→(0,s).
    const p = applyAffine(rot, { x: 51, y: 50 });
    expect(p.x - c.x).toBeCloseTo(0, 9);
    expect(p.y - c.y).toBeCloseTo(0.05, 9);
    // Similarity properties preserved.
    expect(similarityScale(rot)).toBeCloseTo(0.05, 9);
    expect(similarityRotation(rot)).toBeCloseTo(Math.PI / 2, 9);
  });

  it('adjustAffine scales about the centre (pivot fixed, scale multiplied)', () => {
    const c = applyAffine(base, { x: 50, y: 50 });
    const scaled = adjustAffine(base, { scaleFactor: 2, center: c });
    expectPointClose(applyAffine(scaled, { x: 50, y: 50 }), c);
    expect(similarityScale(scaled)).toBeCloseTo(0.1, 9);
    const p = applyAffine(scaled, { x: 51, y: 50 });
    expect(p.x - c.x).toBeCloseTo(0.1, 9);
  });
});

describe('similarityFromAnchor', () => {
  it('maps the anchor exactly and carries the given scale and rotation', () => {
    const anchor = pair({ x: 120, y: 340 }, { x: 8.5, y: -3.25 });
    const m = similarityFromAnchor(anchor, 0.02, Math.PI / 6);
    expectPointClose(applyAffine(m, anchor.page), anchor.model);
    expect(similarityScale(m)).toBeCloseTo(0.02, 12);
    expect(similarityRotation(m)).toBeCloseTo(Math.PI / 6, 12);
  });

  it('with zero rotation is a pure scale+translate about the anchor', () => {
    const anchor = pair({ x: 100, y: 50 }, { x: 2, y: 3 });
    const m = similarityFromAnchor(anchor, 0.05, 0);
    // 10 page units right of the anchor → 0.5 m right of its model point.
    expectPointClose(applyAffine(m, { x: 110, y: 50 }), { x: 2.5, y: 3 });
    expectPointClose(applyAffine(m, { x: 100, y: 60 }), { x: 2, y: 3.5 });
  });

  it('agrees with the 2-point solve when fed the solve’s own scale/rotation', () => {
    const pairs: readonly [CalibrationPair, CalibrationPair] = [
      pair({ x: 10, y: 10 }, { x: 1, y: 2 }),
      pair({ x: 210, y: 130 }, { x: 9.4, y: 6.1 }),
    ];
    const solved = solveSimilarityFromCalibration(pairs);
    const rebuilt = similarityFromAnchor(
      pairs[0],
      similarityScale(solved),
      similarityRotation(solved),
    );
    for (const p of [pairs[0].page, pairs[1].page, { x: 0, y: 0 }, { x: 300, y: -40 }]) {
      expectPointClose(applyAffine(rebuilt, p), applyAffine(solved, p));
    }
  });

  it('rejects non-positive or non-finite scale and non-finite rotation', () => {
    const anchor = pair({ x: 0, y: 0 }, { x: 0, y: 0 });
    expect(() => similarityFromAnchor(anchor, 0, 0)).toThrow(/scale/);
    expect(() => similarityFromAnchor(anchor, -0.05, 0)).toThrow(/scale/);
    expect(() => similarityFromAnchor(anchor, Number.NaN, 0)).toThrow(/scale/);
    expect(() => similarityFromAnchor(anchor, 0.05, Number.POSITIVE_INFINITY)).toThrow(/rotation/);
  });
});

describe('invertAffine', () => {
  it('round-trips points through inverse', () => {
    const m: Affine2x3 = [1.5, -0.4, 12, 0.4, 1.5, -7];
    const inv = invertAffine(m);
    const p: Point2 = { x: 33.3, y: -8.25 };
    expectPointClose(applyAffine(inv, applyAffine(m, p)), p);
    expectPointClose(applyAffine(m, applyAffine(inv, p)), p);
  });

  it('throws on a singular affine', () => {
    expect(() => invertAffine([1, 2, 0, 2, 4, 0])).toThrow(/singular/);
    expect(() => invertAffine([0, 0, 3, 0, 0, 4])).toThrow(/singular/);
  });
});
