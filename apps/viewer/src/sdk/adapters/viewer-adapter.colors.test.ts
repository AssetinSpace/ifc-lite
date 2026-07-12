/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Regression tests for the AIM bridge FOCUS/HIGHLIGHT_FILTER interplay (#2):
// resetColors(refs) silently ignored `refs` and cleared the WHOLE override
// map, so restoring the previous focus set wiped an active highlight filter
// (host UI and 3D desynced). Colour bookkeeping now lives in the adapter,
// because `pendingColorUpdates` is a one-shot channel (nulled after being
// consumed by useGeometryStreaming) and scene.setColorOverrides replaces the
// full set per call.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewerAdapter } from './viewer-adapter.js';
import type { StoreApi } from './types.js';

type Rgba = [number, number, number, number];

const ORANGE: Rgba = [1, 0.5, 0, 1];
const BLUE: Rgba = [0.2, 0.4, 1, 1];

/**
 * Store stub: one model 'm' with idOffset 0 (globalId === expressId, the
 * single-model fallback in toGlobalIdFromModels) and a pendingColorUpdates
 * channel that mimics the real one-shot consumption.
 */
function makeStore() {
  const writes: Array<Map<number, Rgba>> = [];
  const state = {
    models: new Map([['m', { idOffset: 0 }]]),
    pendingColorUpdates: null as Map<number, Rgba> | null,
    setPendingColorUpdates(map: Map<number, Rgba>) {
      writes.push(map);
      // Real consumer (useGeometryStreaming) applies the map and nulls the
      // channel — model that here so tests exercise the cross-tick path.
      state.pendingColorUpdates = null;
    },
  };
  const store = {
    getState: () => state,
    subscribe: () => () => {},
  } as unknown as StoreApi;
  return { store, writes };
}

const ref = (expressId: number) => ({ modelId: 'm', expressId });

test('resetColors(refs) removes only the given refs, keeping other overrides', () => {
  const { store, writes } = makeStore();
  const viewer = createViewerAdapter(store);

  viewer.colorize([ref(1), ref(2), ref(3)], BLUE); // HIGHLIGHT_FILTER
  viewer.colorize([ref(10)], ORANGE); // FOCUS A
  viewer.resetColors([ref(10)]); // FOCUS B restores A first

  const last = writes.at(-1)!;
  assert.deepEqual([...last.keys()].sort((a, b) => a - b), [1, 2, 3]);
  assert.deepEqual(last.get(1), BLUE);
  assert.equal(last.has(10), false);
});

test('resetColors() without refs clears everything (empty map, not null)', () => {
  const { store, writes } = makeStore();
  const viewer = createViewerAdapter(store);

  viewer.colorize([ref(1)], BLUE);
  viewer.resetColors();

  const last = writes.at(-1)!;
  // Empty map is load-bearing: it triggers scene.clearColorOverrides();
  // null would skip the consuming effect entirely.
  assert.equal(last.size, 0);
});

test('colorize accumulates across ticks even after the channel was consumed', () => {
  const { store, writes } = makeStore();
  const viewer = createViewerAdapter(store);

  viewer.colorize([ref(1)], BLUE);
  // channel is now null (consumed) — a second colorize must not lose ref 1
  viewer.colorize([ref(2)], ORANGE);

  const last = writes.at(-1)!;
  assert.deepEqual(last.get(1), BLUE);
  assert.deepEqual(last.get(2), ORANGE);
});

test('colorizeAll replaces the applied set wholesale', () => {
  const { store, writes } = makeStore();
  const viewer = createViewerAdapter(store);

  viewer.colorize([ref(1)], BLUE);
  viewer.colorizeAll([{ refs: [ref(5)], color: ORANGE }]);

  const last = writes.at(-1)!;
  assert.equal(last.has(1), false);
  assert.deepEqual(last.get(5), ORANGE);
});
