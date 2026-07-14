/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from 'vitest';

import {
  createDrawingPlacement,
  DEFAULT_UNDERLAY_OPACITY,
  parsePlacement,
  serializePlacement,
  type DrawingPlacement,
} from './placement.js';

const A0_PORTRAIT: [number, number] = [841, 1189];

function samplePlacement(): DrawingPlacement {
  return createDrawingPlacement({
    storeyGuid: '2O2Fr$t4X7Zf8NOew3FLOH',
    storeyZ: 3.02,
    page: 1,
    pageSize: A0_PORTRAIT,
    affine: [0.05, 0, -1.2, 0, 0.05, 4.5],
    calibration: [
      { page: { x: 100, y: 200 }, model: { x: 3.8, y: 14.5 } },
      { page: { x: 700, y: 900 }, model: { x: 33.8, y: 49.5 } },
    ],
    discipline: 'ARCH',
    calibratedAt: '2026-07-14T10:00:00.000Z',
  });
}

describe('createDrawingPlacement', () => {
  it('applies defaults and converts calibration pairs to tuple form', () => {
    const p = samplePlacement();
    expect(p.version).toBe(1);
    expect(p.opacity).toBe(DEFAULT_UNDERLAY_OPACITY);
    expect(p.visible).toBe(true);
    expect(p.calibration).toEqual([
      { pdfPt: [100, 200], ifcM: [3.8, 14.5] },
      { pdfPt: [700, 900], ifcM: [33.8, 49.5] },
    ]);
  });

  it('clamps opacity into 0..1', () => {
    const base = samplePlacement();
    const over = createDrawingPlacement({ ...base, affine: base.affine, calibration: [], opacity: 1.7 });
    const under = createDrawingPlacement({ ...base, affine: base.affine, calibration: [], opacity: -0.3 });
    expect(over.opacity).toBe(1);
    expect(under.opacity).toBe(0);
  });
});

describe('serializePlacement / parsePlacement round-trip', () => {
  it('survives a JSON round-trip unchanged', () => {
    const p = samplePlacement();
    const json = JSON.parse(JSON.stringify(serializePlacement(p)));
    const back = parsePlacement(json);
    expect(back).toEqual(p);
  });

  it('serializes to the snake_case v1 wire shape', () => {
    const g = serializePlacement(samplePlacement());
    expect(g).toMatchObject({
      version: 1,
      storey_guid: '2O2Fr$t4X7Zf8NOew3FLOH',
      storey_z: 3.02,
      page: 1,
      page_size: [841, 1189],
      discipline: 'ARCH',
      calibrated_at: '2026-07-14T10:00:00.000Z',
    });
    expect(g.calibration[0]).toEqual({ pdf_pt: [100, 200], ifc_m: [3.8, 14.5] });
  });
});

describe('parsePlacement validation (untrusted input)', () => {
  const valid = () => JSON.parse(JSON.stringify(serializePlacement(samplePlacement())));

  it('rejects non-objects', () => {
    expect(parsePlacement(null)).toBeNull();
    expect(parsePlacement(undefined)).toBeNull();
    expect(parsePlacement('georef')).toBeNull();
    expect(parsePlacement(42)).toBeNull();
    expect(parsePlacement([])).toBeNull();
  });

  it('rejects unknown versions', () => {
    expect(parsePlacement({ ...valid(), version: 2 })).toBeNull();
    expect(parsePlacement({ ...valid(), version: undefined })).toBeNull();
  });

  it('rejects missing or empty storey_guid', () => {
    expect(parsePlacement({ ...valid(), storey_guid: '' })).toBeNull();
    expect(parsePlacement({ ...valid(), storey_guid: 7 })).toBeNull();
  });

  it('rejects non-finite numerics', () => {
    expect(parsePlacement({ ...valid(), storey_z: Number.NaN })).toBeNull();
    const g = valid();
    g.affine[3] = Number.POSITIVE_INFINITY;
    expect(parsePlacement(g)).toBeNull();
  });

  it('rejects malformed page / page_size / affine shapes', () => {
    expect(parsePlacement({ ...valid(), page: 0 })).toBeNull();
    expect(parsePlacement({ ...valid(), page: 1.5 })).toBeNull();
    expect(parsePlacement({ ...valid(), page_size: [841] })).toBeNull();
    expect(parsePlacement({ ...valid(), page_size: [841, 0] })).toBeNull();
    expect(parsePlacement({ ...valid(), affine: [1, 0, 0, 0, 1] })).toBeNull();
  });

  it('rejects malformed calibration entries', () => {
    expect(parsePlacement({ ...valid(), calibration: 'nope' })).toBeNull();
    expect(parsePlacement({ ...valid(), calibration: [{ pdf_pt: [1, 2] }] })).toBeNull();
    expect(
      parsePlacement({ ...valid(), calibration: [{ pdf_pt: [1, 2, 3], ifc_m: [1, 2] }] }),
    ).toBeNull();
  });

  it('defaults optional presentation fields when absent or wrong-typed', () => {
    const g = valid();
    delete g.opacity;
    delete g.visible;
    g.discipline = 12;
    g.calibrated_at = 12;
    const p = parsePlacement(g);
    expect(p).not.toBeNull();
    expect(p!.opacity).toBe(DEFAULT_UNDERLAY_OPACITY);
    expect(p!.visible).toBe(true);
    expect(p!.discipline).toBeNull();
    expect(p!.calibratedAt).toBeNull();
  });

  it('clamps out-of-range persisted opacity', () => {
    expect(parsePlacement({ ...valid(), opacity: 5 })!.opacity).toBe(1);
    expect(parsePlacement({ ...valid(), opacity: -1 })!.opacity).toBe(0);
  });
});
