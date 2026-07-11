/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  SOURCE,
  isInboundMessage,
  resolveGuids,
  guidForEntity,
  type GuidResolvableModel,
} from './bridge-protocol.js';

/**
 * Build a fake federated model whose GlobalId index is backed by a plain
 * `guid -> expressId` map — the same O(1) contract the real entity table
 * exposes (packages/data/src/entity-table.ts), minus the parser.
 */
function fakeModel(guidToExpressId: Record<string, number>): GuidResolvableModel {
  const forward = new Map(Object.entries(guidToExpressId));
  const reverse = new Map([...forward].map(([guid, id]) => [id, guid]));
  return {
    ifcDataStore: {
      entities: {
        getExpressIdByGlobalId: (guid: string) => forward.get(guid) ?? -1,
        getGlobalId: (id: number) => reverse.get(id) ?? '',
      },
    },
  };
}

describe('isInboundMessage', () => {
  it('accepts every message shape the bridge handles', () => {
    assert.ok(isInboundMessage({ source: SOURCE, type: 'FOCUS', guids: ['a'] }));
    assert.ok(isInboundMessage({ source: SOURCE, type: 'HIGHLIGHT_FILTER', guids: [] }));
    assert.ok(isInboundMessage({ source: SOURCE, type: 'CLEAR_FILTER' }));
  });

  it('rejects the noise every window sees', () => {
    // DevTools / HMR / extensions post foreign or malformed messages.
    assert.equal(isInboundMessage({ source: 'react-devtools-bridge', type: 'FOCUS' }), false);
    assert.equal(isInboundMessage({ type: 'FOCUS', guids: ['a'] }), false); // no source
    assert.equal(isInboundMessage({ source: SOURCE }), false); // no type
    assert.equal(isInboundMessage({ source: SOURCE, type: 42 }), false); // non-string type
    assert.equal(isInboundMessage(null), false);
    assert.equal(isInboundMessage(undefined), false);
    assert.equal(isInboundMessage('FOCUS'), false);
  });
});

describe('resolveGuids', () => {
  it('resolves GUIDs across a federation, preserving input order', () => {
    const models = new Map<string, GuidResolvableModel>([
      ['asr', fakeModel({ 'guid-wall': 10, 'guid-slab': 11 })],
      ['vzt', fakeModel({ 'guid-duct': 20 })],
    ]);

    assert.deepEqual(resolveGuids(models, ['guid-duct', 'guid-wall']), [
      { modelId: 'vzt', expressId: 20 },
      { modelId: 'asr', expressId: 10 },
    ]);
  });

  it('drops unknown GUIDs (result can be shorter than input)', () => {
    const models = new Map<string, GuidResolvableModel>([['asr', fakeModel({ 'guid-wall': 10 })]]);

    assert.deepEqual(resolveGuids(models, ['nope', 'guid-wall', 'also-nope']), [
      { modelId: 'asr', expressId: 10 },
    ]);
    assert.deepEqual(resolveGuids(models, ['nope']), []);
  });

  it('stops at the first model that owns a GUID (no duplicate refs)', () => {
    // Same GUID present in two models — federation should pick exactly one.
    const models = new Map<string, GuidResolvableModel>([
      ['first', fakeModel({ shared: 1 })],
      ['second', fakeModel({ shared: 2 })],
    ]);

    assert.deepEqual(resolveGuids(models, ['shared']), [{ modelId: 'first', expressId: 1 }]);
  });

  it('skips models whose data store has not loaded yet', () => {
    const models = new Map<string, GuidResolvableModel>([
      ['loading', { ifcDataStore: null }],
      ['ready', fakeModel({ 'guid-wall': 10 })],
    ]);

    assert.deepEqual(resolveGuids(models, ['guid-wall']), [{ modelId: 'ready', expressId: 10 }]);
  });

  it('returns an empty array for no models and no guids', () => {
    assert.deepEqual(resolveGuids(new Map(), ['guid-wall']), []);
    assert.deepEqual(resolveGuids(new Map([['asr', fakeModel({ x: 1 })]]), []), []);
  });
});

describe('guidForEntity', () => {
  const models = new Map<string, GuidResolvableModel>([
    ['asr', fakeModel({ 'guid-wall': 10 })],
  ]);

  it('returns the GlobalId for a known ref', () => {
    assert.equal(guidForEntity(models, { modelId: 'asr', expressId: 10 }), 'guid-wall');
  });

  it('returns undefined when the model is gone', () => {
    assert.equal(guidForEntity(models, { modelId: 'ghost', expressId: 10 }), undefined);
  });

  it('returns undefined (not "") when the entity has no GlobalId', () => {
    // getGlobalId falls back to '' for unknown ids; the bridge must not emit
    // an ENTITY_SELECTED with an empty guid.
    assert.equal(guidForEntity(models, { modelId: 'asr', expressId: 999 }), undefined);
  });

  it('returns undefined when the data store has not loaded', () => {
    const loading = new Map<string, GuidResolvableModel>([['asr', { ifcDataStore: null }]]);
    assert.equal(guidForEntity(loading, { modelId: 'asr', expressId: 10 }), undefined);
  });
});
