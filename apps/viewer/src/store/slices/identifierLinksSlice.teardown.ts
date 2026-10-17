/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * AIM fork (D-076): the identifier index references the outgoing model's
 * stores, so a session reset drops it; the per-project config reloads via
 * `useIdentifierLinks` on the next model.
 */

import { defineSliceTeardown, notApplicable } from '../teardown.js';

export const identifierLinksTeardown = defineSliceTeardown(
  'identifierLinksSlice',
  ['identifierIndex', 'identifierIndexStatus', 'identifierIndexSignature', 'identifierConfigModelKey'],
  {
    'session-reset': () => ({
      identifierIndex: null,
      identifierIndexStatus: 'idle',
      identifierIndexSignature: null,
      identifierConfigModelKey: null,
    }),
    'model-removed': notApplicable,
    'all-models-cleared': notApplicable,
  },
);
