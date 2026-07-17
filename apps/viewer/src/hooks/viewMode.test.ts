/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { deriveViewMode } from './viewModeCore.js';

describe('deriveViewMode (D-075) — flag combinations → user-facing mode', () => {
  it('maps the canonical states', () => {
    assert.strictEqual(
      deriveViewMode({ splitView: false, planFull: false, viewLocked: false }),
      '3d',
    );
    assert.strictEqual(
      deriveViewMode({ splitView: true, planFull: false, viewLocked: false }),
      'split',
    );
    assert.strictEqual(
      deriveViewMode({ splitView: true, planFull: true, viewLocked: false }),
      '2d',
    );
    // Locked top-down calibration / no-drawing fallback reads as 2D.
    assert.strictEqual(
      deriveViewMode({ splitView: false, planFull: false, viewLocked: true }),
      '2d',
    );
  });

  it('plan-full without split is NOT 2d (stale flag must not flip the mode)', () => {
    // enterPlanView always sets both; a lone planFull can only be a stale
    // remnant and must read as the default workspace.
    assert.strictEqual(
      deriveViewMode({ splitView: false, planFull: true, viewLocked: false }),
      '3d',
    );
  });

  it('split wins over a simultaneously locked view', () => {
    // enterSplitView clears the lock; if both are ever set, the split pane is
    // the visible surface, so the mode must follow it.
    assert.strictEqual(
      deriveViewMode({ splitView: true, planFull: false, viewLocked: true }),
      'split',
    );
  });
});
