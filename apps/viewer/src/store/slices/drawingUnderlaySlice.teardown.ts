/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * AIM fork (D-072): what `drawingUnderlaySlice` drops on a session reset.
 *
 * The AIM host re-sends its drawing list after the next MODELS_LOADED, so a
 * model swap starts from a clean slate. Model removal / clearing all models
 * leave the underlays alone (same as before the upstream teardown registry).
 */

import { defineSliceTeardown, notApplicable } from '../teardown.js';

export const drawingUnderlayTeardown = defineSliceTeardown(
  'drawingUnderlaySlice',
  [
    'underlayDrawings',
    'underlayCalibration',
    'underlayPanelVisible',
    'underlayCut',
    'underlayViewLocked',
    'underlaySplitView',
    'underlayPlanFull',
    'underlayLastStoreyGuid',
    'underlayCalibrationExpanded',
    'underlayActiveStoreyGuid',
  ],
  {
    'session-reset': () => ({
      underlayDrawings: new Map(),
      underlayCalibration: null,
      underlayPanelVisible: false,
      underlayCut: null,
      underlayViewLocked: false,
      underlaySplitView: false,
      underlayPlanFull: false,
      underlayLastStoreyGuid: null,
      underlayCalibrationExpanded: false,
      underlayActiveStoreyGuid: null,
    }),
    'model-removed': notApplicable,
    'all-models-cleared': notApplicable,
  },
);
