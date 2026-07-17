/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mapTextTransformToViewport } from './rasterize.js';

const apply = (m: number[], x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

describe('mapTextTransformToViewport', () => {
  it('is the identity for an unrotated page', () => {
    // pdf.js scale-1 viewport transform of an unrotated page is the y-flip.
    const H = 842;
    const item = [2, 0, 0, 2, 72, 700];
    const out = mapTextTransformToViewport(item, [1, 0, 0, -1, 0, H], H);
    assert.deepEqual(out.map((v) => Math.round(v * 1e9) / 1e9), item);
  });

  it('carries a /Rotate 90 page into the viewed y-up frame', () => {
    // Synthetic 90° viewport: user (x, y) → device (y, x); the viewed page is
    // rawH wide and rawW tall, so the y-up flip uses H_view = rawW.
    const rawW = 595;
    const vt90 = [0, 1, 1, 0, 0, 0];
    const out = mapTextTransformToViewport([1, 0, 0, 1, 100, 200], vt90, rawW);
    // Text origin (100, 200) → device (200, 100) → y-up (200, rawW - 100).
    const [ox, oy] = apply(out, 0, 0);
    assert.equal(ox, 200);
    assert.equal(oy, rawW - 100);
    // A step along the text baseline (+x in text space) moves along +y in the
    // viewed frame — the run reads as rotated, which tokenBounds handles.
    const [sx, sy] = apply(out, 10, 0);
    assert.equal(sx - ox, 0);
    assert.equal(sy - oy, -10);
    assert.equal(Math.hypot(sx - ox, sy - oy), 10, 'lengths preserved');
  });
});
