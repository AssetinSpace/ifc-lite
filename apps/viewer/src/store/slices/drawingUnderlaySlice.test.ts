/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createDrawingUnderlaySlice, type DrawingUnderlaySlice } from './drawingUnderlaySlice.js';

describe('DrawingUnderlaySlice — calibration storey retarget', () => {
  let state: DrawingUnderlaySlice;
  let setState: (
    partial:
      | Partial<DrawingUnderlaySlice>
      | ((state: DrawingUnderlaySlice) => Partial<DrawingUnderlaySlice>),
  ) => void;

  beforeEach(() => {
    setState = (partial) => {
      const update = typeof partial === 'function' ? partial(state) : partial;
      state = { ...state, ...update };
    };
    state = createDrawingUnderlaySlice(
      setState as never,
      () => state,
      {} as never,
    );
  });

  it('is a no-op without an active calibration', () => {
    state.retargetUnderlayCalibrationStorey({ guid: 'G2', z: 5 });
    assert.strictEqual(state.underlayCalibration, null);
  });

  it('rebinds the draft storey and clears model points, keeping page points', () => {
    state.startUnderlayCalibration('d1', 1, { guid: 'G1', z: 2 });
    state.addUnderlayCalibrationPagePoint({ x: 10, y: 20 });
    state.addUnderlayCalibrationModelPoint({ x: 1, y: 2 });

    state.retargetUnderlayCalibrationStorey({ guid: 'G2', z: 5 });

    const c = state.underlayCalibration;
    assert.ok(c);
    assert.strictEqual(c.storeyGuid, 'G2');
    assert.strictEqual(c.storeyZ, 5);
    assert.deepStrictEqual(c.pagePoints, [{ x: 10, y: 20 }]);
    assert.deepStrictEqual(c.modelPoints, []);
  });

  it('keeps the draft identical when retargeting to the same storey', () => {
    state.startUnderlayCalibration('d1', 1, { guid: 'G1', z: 2 });
    state.addUnderlayCalibrationPagePoint({ x: 10, y: 20 });
    state.addUnderlayCalibrationModelPoint({ x: 1, y: 2 });
    const before = state.underlayCalibration;

    state.retargetUnderlayCalibrationStorey({ guid: 'G1', z: 2 });

    assert.strictEqual(state.underlayCalibration, before);
  });

  it('one-point mode trims picks to the anchor pair and caps page points at 1', () => {
    state.startUnderlayCalibration('d1', 1, { guid: 'G1', z: 2 });
    state.addUnderlayCalibrationPagePoint({ x: 1, y: 1 });
    state.addUnderlayCalibrationModelPoint({ x: 2, y: 2 });
    state.addUnderlayCalibrationPagePoint({ x: 3, y: 3 });

    state.setUnderlayCalibrationMode('one-point');
    let c = state.underlayCalibration;
    assert.ok(c);
    assert.strictEqual(c.mode, 'one-point');
    assert.deepStrictEqual(c.pagePoints, [{ x: 1, y: 1 }]);
    assert.deepStrictEqual(c.modelPoints, [{ x: 2, y: 2 }]);

    state.addUnderlayCalibrationPagePoint({ x: 9, y: 9 }); // over the 1-pair cap
    c = state.underlayCalibration;
    assert.ok(c);
    assert.strictEqual(c.pagePoints.length, 1);

    state.setUnderlayCalibrationOneParams({ scaleDen: 75, rotationDeg: -1.5 });
    c = state.underlayCalibration;
    assert.ok(c);
    assert.strictEqual(c.oneScaleDen, 75);
    assert.strictEqual(c.oneRotationDeg, -1.5);
  });

  it('allows re-picking model points after a retarget (alternation intact)', () => {
    state.startUnderlayCalibration('d1', 1, { guid: 'G1', z: 2 });
    state.addUnderlayCalibrationPagePoint({ x: 10, y: 20 });
    state.addUnderlayCalibrationModelPoint({ x: 1, y: 2 });
    state.addUnderlayCalibrationPagePoint({ x: 30, y: 40 });

    state.retargetUnderlayCalibrationStorey({ guid: 'G2', z: 5 });
    state.addUnderlayCalibrationModelPoint({ x: 7, y: 8 });
    state.addUnderlayCalibrationModelPoint({ x: 9, y: 10 });
    state.addUnderlayCalibrationModelPoint({ x: 11, y: 12 }); // over cap — ignored

    const c = state.underlayCalibration;
    assert.ok(c);
    assert.strictEqual(c.pagePoints.length, 2);
    assert.deepStrictEqual(c.modelPoints, [
      { x: 7, y: 8 },
      { x: 9, y: 10 },
    ]);
  });
});
