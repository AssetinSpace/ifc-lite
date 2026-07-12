/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Regression tests for the AIM bridge FOCUS camera move (#2): the local
// backend's viewer.flyTo() was a no-op, so FOCUS colorized + selected an
// entity but never moved the camera. It now routes refs -> globalIds through
// the renderer's frameEntities callback, WITHOUT mutating selection (which
// would race the selection-ref sync and echo ENTITY_SELECTED back to hosts).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewerAdapter } from './viewer-adapter.js';
import type { StoreApi } from './types.js';

/**
 * Store stub: two federated models with distinct idOffsets so ref->globalId
 * conversion is observable, plus a spy on the frameEntities camera callback
 * and on every selection/colour setter (to prove flyTo touches none of them).
 */
function makeStore() {
  const framed: number[][] = [];
  const touched: string[] = [];
  const state = {
    models: new Map([
      ['asr', { idOffset: 0 }],
      ['vzt', { idOffset: 1000 }],
    ]),
    cameraCallbacks: {
      frameEntities: (ids: number[]) => framed.push(ids),
    },
    // Any of these firing during flyTo would be a selection/colour side effect.
    setPendingColorUpdates: () => touched.push('setPendingColorUpdates'),
    setSelectedEntity: () => touched.push('setSelectedEntity'),
    setSelectedEntityIds: () => touched.push('setSelectedEntityIds'),
    setSelectedEntityId: () => touched.push('setSelectedEntityId'),
    addEntityToSelection: () => touched.push('addEntityToSelection'),
  };
  const store = {
    getState: () => state,
    subscribe: () => () => {},
  } as unknown as StoreApi;
  return { store, framed, touched, state };
}

const ref = (modelId: string, expressId: number) => ({ modelId, expressId });

test('flyTo frames the refs as global ids via the camera callback', () => {
  const { store, framed } = makeStore();
  const viewer = createViewerAdapter(store);

  viewer.flyTo([ref('asr', 10), ref('vzt', 5)]);

  assert.equal(framed.length, 1);
  // asr idOffset 0 -> 10; vzt idOffset 1000 -> 1005
  assert.deepEqual(framed[0], [10, 1005]);
});

test('flyTo never mutates selection or colour state', () => {
  const { store, touched } = makeStore();
  const viewer = createViewerAdapter(store);

  viewer.flyTo([ref('asr', 10)]);

  assert.deepEqual(touched, []);
});

test('flyTo skips refs whose model is not loaded, does not frame when none resolve', () => {
  const { store, framed } = makeStore();
  const viewer = createViewerAdapter(store);

  viewer.flyTo([ref('ghost', 1)]);
  assert.equal(framed.length, 0);

  viewer.flyTo([ref('ghost', 1), ref('asr', 7)]);
  assert.deepEqual(framed.at(-1), [7]);
});

test('flyTo is a safe no-op before the viewport registers callbacks', () => {
  const { store, state } = makeStore();
  // Callbacks not registered yet (empty object, as cameraSlice initializes).
  (state as { cameraCallbacks: Record<string, unknown> }).cameraCallbacks = {};
  const viewer = createViewerAdapter(store);

  assert.doesNotThrow(() => viewer.flyTo([ref('asr', 1)]));
});
