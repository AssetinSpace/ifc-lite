/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { isMobileViewport, MOBILE_MAX_WIDTH, TOUCH_MOBILE_MAX_WIDTH } from './viewport.js';

describe('isMobileViewport', () => {
  it('treats any narrow window as mobile, touch or not', () => {
    assert.strictEqual(isMobileViewport(390, true), true); // phone portrait
    assert.strictEqual(isMobileViewport(390, false), true); // narrow desktop window
    assert.strictEqual(isMobileViewport(MOBILE_MAX_WIDTH - 1, false), true);
  });

  it('keeps touch devices mobile up to the tablet cutoff', () => {
    // iPad portrait and a phone in landscape both land in this band.
    assert.strictEqual(isMobileViewport(768, true), true);
    assert.strictEqual(isMobileViewport(844, true), true);
    assert.strictEqual(isMobileViewport(TOUCH_MOBILE_MAX_WIDTH - 1, true), true);
  });

  it('is desktop at the same widths without touch', () => {
    assert.strictEqual(isMobileViewport(768, false), false);
    assert.strictEqual(isMobileViewport(1023, false), false);
  });

  it('is desktop at and above the tablet cutoff', () => {
    // iPad landscape: touch, but wide enough for the desktop ribbon.
    assert.strictEqual(isMobileViewport(TOUCH_MOBILE_MAX_WIDTH, true), false);
    assert.strictEqual(isMobileViewport(1440, true), false);
    assert.strictEqual(isMobileViewport(1440, false), false);
  });
});
