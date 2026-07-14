/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import { createDrawingPlacement } from './placement.js';
import { applyAffine, solveSimilarityFromCalibration, type CalibrationPair } from './similarity.js';
import {
  DEFAULT_PLANE_LIFT,
  ifcMetresToPage,
  ifcToWorld,
  pageToIfcMetres,
  placementWorldCorners,
  worldToIfcMetres,
  worldToIfcZ,
  ZERO_OFFSET,
  type Vec3,
} from './world-transform.js';

/** Synthetic RTC-style recentering offset — deliberately non-zero in every axis. */
const RTC_OFFSET: Vec3 = { x: 5_012.5, y: -3.75, z: -4_998.25 };

describe('ifcToWorld / worldToIfcMetres', () => {
  it('applies the IFC Z-up → viewer Y-up axis swap with zero offset', () => {
    const w = ifcToWorld({ x: 10, y: 20 }, 3, ZERO_OFFSET);
    expect(w).toEqual({ x: 10, y: 3, z: -20 });
  });

  it('round-trips through a non-zero recentering offset', () => {
    const ifc = { x: 123.45, y: -67.8 };
    const w = ifcToWorld(ifc, 6.5, RTC_OFFSET);
    const back = worldToIfcMetres(w, RTC_OFFSET);
    expect(back.x).toBeCloseTo(ifc.x, 9);
    expect(back.y).toBeCloseTo(ifc.y, 9);
    expect(worldToIfcZ(w, RTC_OFFSET)).toBeCloseTo(6.5, 9);
  });

  it('keeps the -offset.y term (the plane must NOT assume off.y = 0)', () => {
    const w = ifcToWorld({ x: 0, y: 0 }, 3, RTC_OFFSET);
    expect(w.y).toBeCloseTo(3 - RTC_OFFSET.y, 9);
  });
});

describe('pageToIfcMetres / ifcMetresToPage', () => {
  it('round-trips through the placement affine', () => {
    const affine = solveSimilarityFromCalibration([
      { page: { x: 0, y: 0 }, model: { x: 2, y: 3 } },
      { page: { x: 100, y: 0 }, model: { x: 7, y: 3 } },
    ]);
    const page = { x: 320.5, y: 88 };
    const back = ifcMetresToPage(affine, pageToIfcMetres(affine, page));
    expect(back.x).toBeCloseTo(page.x, 9);
    expect(back.y).toBeCloseTo(page.y, 9);
  });
});

describe('placementWorldCorners', () => {
  // Calibration: identity-ish plan at scale 0.05 (100 pt = 5 m), no rotation.
  const pairs: [CalibrationPair, CalibrationPair] = [
    { page: { x: 0, y: 0 }, model: { x: 0, y: 0 } },
    { page: { x: 100, y: 0 }, model: { x: 5, y: 0 } },
  ];
  const placement = createDrawingPlacement({
    storeyGuid: 'GUID',
    storeyZ: 3,
    page: 1,
    pageSize: [800, 600],
    affine: solveSimilarityFromCalibration(pairs),
    calibration: pairs,
  });

  it('places all four corners on the lifted storey plane', () => {
    const c = placementWorldCorners(placement, RTC_OFFSET);
    const expectedY = 3 + DEFAULT_PLANE_LIFT - RTC_OFFSET.y;
    for (const corner of [c.tl, c.tr, c.br, c.bl]) {
      expect(corner.y).toBeCloseTo(expectedY, 9);
    }
    expect(c.planeY).toBeCloseTo(expectedY, 9);
  });

  it('maps page corners through affine + axis swap (uv orientation contract)', () => {
    const c = placementWorldCorners(placement, ZERO_OFFSET, 0);
    // Page (0,0) = bl → IFC (0,0) → world (0, 3, 0).
    expect(c.bl).toEqual({ x: 0, y: 3, z: -0 });
    // Page (800,0) = br → IFC (40,0) → world (40, 3, 0).
    expect(c.br.x).toBeCloseTo(40, 9);
    expect(c.br.z).toBeCloseTo(0, 9);
    // Page (0,600) = tl → IFC (0,30) → world (0, 3, -30).
    expect(c.tl.x).toBeCloseTo(0, 9);
    expect(c.tl.z).toBeCloseTo(-30, 9);
    // Page (800,600) = tr → IFC (40,30) → world (40, 3, -30).
    expect(c.tr.x).toBeCloseTo(40, 9);
    expect(c.tr.z).toBeCloseTo(-30, 9);
  });

  it('honours a custom lift', () => {
    const c = placementWorldCorners(placement, ZERO_OFFSET, 0.5);
    expect(c.planeY).toBeCloseTo(3.5, 9);
  });

  it('keeps corners consistent with a rotated calibration', () => {
    // 90° CCW: page +x axis lands on IFC +y.
    const rotPairs: [CalibrationPair, CalibrationPair] = [
      { page: { x: 0, y: 0 }, model: { x: 10, y: 10 } },
      { page: { x: 100, y: 0 }, model: { x: 10, y: 15 } },
    ];
    const rotated = createDrawingPlacement({
      storeyGuid: 'GUID',
      storeyZ: 0,
      page: 1,
      pageSize: [100, 100],
      affine: solveSimilarityFromCalibration(rotPairs),
      calibration: rotPairs,
    });
    const c = placementWorldCorners(rotated, ZERO_OFFSET, 0);
    // bl = page(0,0) → IFC (10,10); tl = page(0,100) → page +y → IFC -x → (5,10).
    expect(worldToIfcMetres(c.bl, ZERO_OFFSET).x).toBeCloseTo(10, 9);
    expect(worldToIfcMetres(c.bl, ZERO_OFFSET).y).toBeCloseTo(10, 9);
    expect(worldToIfcMetres(c.tl, ZERO_OFFSET).x).toBeCloseTo(5, 9);
    expect(worldToIfcMetres(c.tl, ZERO_OFFSET).y).toBeCloseTo(10, 9);
    // And the anchor correspondences themselves hold.
    const ifcOfBr = worldToIfcMetres(c.br, ZERO_OFFSET);
    const viaAffine = applyAffine(rotated.affine, { x: 100, y: 0 });
    expect(ifcOfBr.x).toBeCloseTo(viaAffine.x, 9);
    expect(ifcOfBr.y).toBeCloseTo(viaAffine.y, 9);
  });
});
