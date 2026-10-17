/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * AIM fork (D-075): what `documentsSlice` drops on a session reset — same
 * host re-send contract as the drawing underlays.
 */

import { defineSliceTeardown, notApplicable } from '../teardown.js';

export const documentsTeardown = defineSliceTeardown(
  'documentsSlice',
  ['viewerDocuments', 'documentsPanelVisible', 'docTabs', 'activeDocTabId', 'docJump'],
  {
    'session-reset': () => ({
      viewerDocuments: new Map(),
      documentsPanelVisible: false,
      docTabs: [],
      activeDocTabId: null,
      docJump: null,
    }),
    'model-removed': notApplicable,
    'all-models-cleared': notApplicable,
  },
);
