/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { isViewMessage } from './view-protocol.js';
import { VIEWER_AXIS, cameraStep, storeyCutPercent } from './viewCommands.js';

const S = 'aim-bridge';
const G = '27hbQtAoP6qvoEYhPARoI7';

describe('isViewMessage (AIM D-083)', () => {
  it('prijme rez nad podlažím, zvislý rez, zrušenie, kameru a režim', () => {
    for (const msg of [
      { source: S, type: 'SET_SECTION', action: 'set', axis: 'y', storeyGuid: G, offsetM: -0.4 },
      { source: S, type: 'SET_SECTION', action: 'set', storeyGuid: G },
      { source: S, type: 'SET_SECTION', action: 'set', axis: 'x', position: 40, flipped: true },
      { source: S, type: 'SET_SECTION', action: 'clear' },
      { source: S, type: 'SET_CAMERA', preset: 'top', projection: 'orthographic', guids: [G] },
      { source: S, type: 'SET_CAMERA', preset: 'iso' },
      { source: S, type: 'SET_VIEW_MODE', mode: '2d', storeyGuid: G },
      { source: S, type: 'SET_VIEW_MODE', mode: '3d' },
    ]) {
      assert.equal(isViewMessage(msg), true, JSON.stringify(msg));
    }
  });

  it('odmietne cudzí zdroj, zlé hodnoty a správy, ktoré nie sú pohľad', () => {
    for (const msg of [
      { source: 'x', type: 'SET_SECTION', action: 'clear' },
      { source: S, type: 'SET_SECTION', action: 'set' },
      { source: S, type: 'SET_SECTION', action: 'set', axis: 'x', storeyGuid: G },
      { source: S, type: 'SET_SECTION', action: 'set', storeyGuid: G, offsetM: 99 },
      { source: S, type: 'SET_SECTION', action: 'set', axis: 'z', position: 140 },
      { source: S, type: 'SET_CAMERA', preset: 'diagonal' },
      { source: S, type: 'SET_CAMERA', preset: 'top', guids: [1, 2] },
      { source: S, type: 'SET_VIEW_MODE', mode: '4d' },
      { source: S, type: 'SELECT', guid: G },
      null,
    ]) {
      assert.equal(isViewMessage(msg), false, JSON.stringify(msg));
    }
  });
});

describe('viewCommands (AIM D-083)', () => {
  it('rez nad podlažím: elevácia IFC + výška - posun rámca, v percentách osi', () => {
    // Model od 0 do 20 m; podlažie na 5 m; rez 1,2 m nad ním; rámec posunutý o 2 m.
    assert.ok(Math.abs((storeyCutPercent(5, 1.2, 2, { min: 0, max: 20 }) ?? NaN) - 21) < 1e-9);
    assert.equal(storeyCutPercent(5, 1.2, 0, null), null);
    // Mimo rozsahu sa oreže na okraj.
    assert.equal(storeyCutPercent(30, 0, 0, { min: 0, max: 20 }), 100);
  });

  it('osi a presety', () => {
    assert.deepEqual(VIEWER_AXIS, { x: 'side', y: 'down', z: 'front' });
    assert.deepEqual(cameraStep('iso'), { kind: 'home' });
    assert.deepEqual(cameraStep('fit_all'), { kind: 'fit' });
    assert.deepEqual(cameraStep('front'), { kind: 'preset', view: 'front' });
  });
});
