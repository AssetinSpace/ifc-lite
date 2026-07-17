/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  SOURCE,
  isInboundMessage,
  resolveGuids,
  resolveSelector,
  guidForEntity,
  type GuidResolvableModel,
  type SelectorResolvableModel,
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

  it('rejects FOCUS/HIGHLIGHT_FILTER with a missing or malformed guids payload', () => {
    // Regression: the envelope-only guard let `{type:'FOCUS'}` through and the
    // handler threw a TypeError iterating `undefined` — remotely pokeable noise.
    assert.equal(isInboundMessage({ source: SOURCE, type: 'FOCUS' }), false);
    assert.equal(isInboundMessage({ source: SOURCE, type: 'HIGHLIGHT_FILTER' }), false);
    assert.equal(isInboundMessage({ source: SOURCE, type: 'FOCUS', guids: 'guid-a' }), false);
    assert.equal(isInboundMessage({ source: SOURCE, type: 'FOCUS', guids: ['a', 42] }), false);
    assert.equal(isInboundMessage({ source: SOURCE, type: 'FOCUS', guids: [null] }), false);
  });

  it('rejects unknown message types (forward-compat: ignore, not crash)', () => {
    assert.equal(isInboundMessage({ source: SOURCE, type: 'SELF_DESTRUCT' }), false);
  });

  it('accepts viewer ops (D-066) with guids, selector, or neither', () => {
    assert.ok(isInboundMessage({ source: SOURCE, type: 'COLORIZE', guids: ['a'], color: '#ef4444' }));
    assert.ok(isInboundMessage({ source: SOURCE, type: 'COLORIZE', selector: { types: ['IfcDoor'] }, color: '#ef4444' }));
    assert.ok(isInboundMessage({ source: SOURCE, type: 'HIDE', selector: { model: 'VZT' } }));
    assert.ok(isInboundMessage({ source: SOURCE, type: 'ISOLATE', guids: [] }));
    assert.ok(isInboundMessage({ source: SOURCE, type: 'SHOW' })); // refsForOp resolves to []
    assert.ok(isInboundMessage({ source: SOURCE, type: 'SHOW_ALL' }));
    assert.ok(isInboundMessage({ source: SOURCE, type: 'RESET_COLORS' }));
  });

  it('rejects malformed viewer ops payloads', () => {
    assert.equal(isInboundMessage({ source: SOURCE, type: 'COLORIZE', guids: ['a'] }), false); // no color
    assert.equal(isInboundMessage({ source: SOURCE, type: 'COLORIZE', color: 42, guids: ['a'] }), false);
    assert.equal(isInboundMessage({ source: SOURCE, type: 'HIDE', guids: 'IfcDoor' }), false);
    assert.equal(isInboundMessage({ source: SOURCE, type: 'HIDE', selector: { types: [1] } }), false);
    assert.equal(isInboundMessage({ source: SOURCE, type: 'ISOLATE', selector: 'VZT' }), false);
  });

  it('accepts and validates AIM panel responses', () => {
    assert.ok(isInboundMessage({ source: SOURCE, type: 'AIM_PANEL_DATA', guid: 'g', data: { version: 1, guid: 'g', title: 'Dvere' } }));
    assert.ok(isInboundMessage({ source: SOURCE, type: 'AIM_PANEL_EMPTY', guid: 'g', reason: 'not-found' }));
    assert.equal(isInboundMessage({ source: SOURCE, type: 'AIM_PANEL_DATA', guid: 'g' }), false); // no data
    assert.equal(isInboundMessage({ source: SOURCE, type: 'AIM_PANEL_EMPTY', guid: 'g' }), false); // no reason
  });

  it('accepts and validates UNDERLAYS_LOAD (D-072)', () => {
    const drawing = { documentId: 'doc-1', name: 'Pudorys 1NP', pdfUrl: 'https://x/y.pdf' };
    assert.ok(isInboundMessage({ source: SOURCE, type: 'UNDERLAYS_LOAD', drawings: [] }));
    assert.ok(isInboundMessage({ source: SOURCE, type: 'UNDERLAYS_LOAD', drawings: [drawing] }));
    // georef rides along unvalidated at the envelope level (parsePlacement
    // handles it) — any value is fine as long as the identity fields hold.
    assert.ok(isInboundMessage({
      source: SOURCE,
      type: 'UNDERLAYS_LOAD',
      drawings: [{ ...drawing, georef: { version: 1 } }],
    }));
    assert.equal(isInboundMessage({ source: SOURCE, type: 'UNDERLAYS_LOAD' }), false); // no drawings
    assert.equal(isInboundMessage({ source: SOURCE, type: 'UNDERLAYS_LOAD', drawings: 'x' }), false);
    assert.equal(
      isInboundMessage({ source: SOURCE, type: 'UNDERLAYS_LOAD', drawings: [{ documentId: '', name: 'n', pdfUrl: 'u' }] }),
      false, // empty documentId
    );
    assert.equal(
      isInboundMessage({ source: SOURCE, type: 'UNDERLAYS_LOAD', drawings: [{ documentId: 'd', name: 'n' }] }),
      false, // missing pdfUrl
    );
  });

  it('accepts and validates DOCUMENTS_LOAD (D-075)', () => {
    const doc = { documentId: 'doc-1', name: 'TS sprava.pdf', kind: 'document', url: 'https://x/y.pdf' };
    assert.ok(isInboundMessage({ source: SOURCE, type: 'DOCUMENTS_LOAD', documents: [] }));
    assert.ok(isInboundMessage({ source: SOURCE, type: 'DOCUMENTS_LOAD', documents: [doc] }));
    assert.ok(isInboundMessage({
      source: SOURCE,
      type: 'DOCUMENTS_LOAD',
      documents: [{
        ...doc,
        kind: 'drawing',
        storeyGuid: 'G1',
        folder: ['Budova A', '2.NP'],
        meta: { revision: 'B', status: 'issued' },
        mime: 'application/pdf',
      }],
    }));
    assert.equal(isInboundMessage({ source: SOURCE, type: 'DOCUMENTS_LOAD' }), false); // no documents
    assert.equal(isInboundMessage({ source: SOURCE, type: 'DOCUMENTS_LOAD', documents: 'x' }), false);
    assert.equal(
      isInboundMessage({ source: SOURCE, type: 'DOCUMENTS_LOAD', documents: [{ ...doc, documentId: '' }] }),
      false, // empty documentId
    );
    assert.equal(
      isInboundMessage({ source: SOURCE, type: 'DOCUMENTS_LOAD', documents: [{ ...doc, kind: 'video' }] }),
      false, // unknown kind
    );
    assert.equal(
      isInboundMessage({ source: SOURCE, type: 'DOCUMENTS_LOAD', documents: [{ ...doc, url: undefined }] }),
      false, // missing url
    );
    assert.equal(
      isInboundMessage({ source: SOURCE, type: 'DOCUMENTS_LOAD', documents: [{ ...doc, folder: [1] }] }),
      false, // malformed folder
    );
    assert.equal(
      isInboundMessage({ source: SOURCE, type: 'DOCUMENTS_LOAD', documents: [{ ...doc, meta: { a: 1 } }] }),
      false, // non-string meta value
    );
  });

  it('accepts and validates DOCUMENT_OPEN (D-075)', () => {
    assert.ok(isInboundMessage({ source: SOURCE, type: 'DOCUMENT_OPEN', documentId: 'doc-1' }));
    assert.ok(isInboundMessage({ source: SOURCE, type: 'DOCUMENT_OPEN', documentId: 'doc-1', page: 3 }));
    assert.equal(isInboundMessage({ source: SOURCE, type: 'DOCUMENT_OPEN' }), false); // no id
    assert.equal(isInboundMessage({ source: SOURCE, type: 'DOCUMENT_OPEN', documentId: '' }), false);
    assert.equal(
      isInboundMessage({ source: SOURCE, type: 'DOCUMENT_OPEN', documentId: 'doc-1', page: 'x' }),
      false, // non-numeric page
    );
  });

  it('accepts and validates CAPTURES_LOAD (D-073)', () => {
    const pin = { id: 'c1', kind: 'photo', world: { x: 1, y: 2, z: 3 } };
    assert.ok(isInboundMessage({ source: SOURCE, type: 'CAPTURES_LOAD', captures: [] }));
    assert.ok(isInboundMessage({ source: SOURCE, type: 'CAPTURES_LOAD', captures: [pin] }));
    assert.ok(isInboundMessage({
      source: SOURCE,
      type: 'CAPTURES_LOAD',
      captures: [{ ...pin, kind: 'pano360', name: 'Vstup', thumbUrl: 'https://x/t.jpg' }],
    }));
    assert.equal(isInboundMessage({ source: SOURCE, type: 'CAPTURES_LOAD' }), false); // no captures
    assert.equal(isInboundMessage({ source: SOURCE, type: 'CAPTURES_LOAD', captures: 'x' }), false);
    assert.equal(
      isInboundMessage({ source: SOURCE, type: 'CAPTURES_LOAD', captures: [{ kind: 'photo', world: { x: 0, y: 0, z: 0 } }] }),
      false, // missing id
    );
    assert.equal(
      isInboundMessage({ source: SOURCE, type: 'CAPTURES_LOAD', captures: [{ id: 'c', kind: 'video', world: { x: 0, y: 0, z: 0 } }] }),
      false, // bad kind
    );
    assert.equal(
      isInboundMessage({ source: SOURCE, type: 'CAPTURES_LOAD', captures: [{ id: 'c', kind: 'photo', world: { x: 0, y: 0 } }] }),
      false, // incomplete world
    );
    assert.equal(
      isInboundMessage({ source: SOURCE, type: 'CAPTURES_LOAD', captures: [{ id: 'c', kind: 'photo', world: { x: Infinity, y: 0, z: 0 } }] }),
      false, // non-finite world
    );
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

/**
 * Fake model for selector resolution: rows of [expressId, typeName, hasGeometry].
 */
function fakeSelectorModel(
  name: string,
  rows: [number, string, boolean][],
): SelectorResolvableModel {
  const byId = new Map(rows.map(([id, type, geo]) => [id, { type, geo }]));
  return {
    name,
    ifcDataStore: {
      entities: {
        count: rows.length,
        expressId: Uint32Array.from(rows.map(([id]) => id)),
        getTypeName: (id: number) => byId.get(id)?.type ?? 'Unknown',
        hasGeometry: (id: number) => byId.get(id)?.geo ?? false,
      },
    },
  };
}

describe('resolveSelector', () => {
  const federation = new Map<string, SelectorResolvableModel>([
    ['m-asr', fakeSelectorModel('ASR.ifc', [
      [1, 'IfcWallStandardCase', true],
      [2, 'IfcDoor', true],
      [3, 'IfcDoorType', false], // type object without geometry
      [4, 'IfcSlab', true],
    ])],
    ['m-vzt', fakeSelectorModel('VZT.ifc', [
      [10, 'IfcDuctSegment', true],
      [11, 'IfcFan', true],
      [12, 'IfcAirTerminal', true],
    ])],
  ]);

  it('selects a whole model by name, case-insensitive, with or without extension', () => {
    for (const model of ['VZT', 'vzt', 'VZT.ifc', 'vzt.IFC']) {
      assert.deepEqual(resolveSelector(federation, { model }), [
        { modelId: 'm-vzt', expressId: 10 },
        { modelId: 'm-vzt', expressId: 11 },
        { modelId: 'm-vzt', expressId: 12 },
      ], `model selector "${model}"`);
    }
  });

  it('selects multiple IFC classes across all models (case-insensitive)', () => {
    assert.deepEqual(resolveSelector(federation, { types: ['ifcdoor', 'IfcDuctSegment'] }), [
      { modelId: 'm-asr', expressId: 2 },
      { modelId: 'm-vzt', expressId: 10 },
    ]);
  });

  it('maps StandardCase variants to their base class', () => {
    assert.deepEqual(resolveSelector(federation, { types: ['IfcWall'] }), [
      { modelId: 'm-asr', expressId: 1 },
    ]);
  });

  it('combines types with a model scope', () => {
    assert.deepEqual(
      resolveSelector(federation, { types: ['IfcDoor', 'IfcFan'], model: 'VZT' }),
      [{ modelId: 'm-vzt', expressId: 11 }],
    );
  });

  it('skips entities without geometry (type objects)', () => {
    const doors = resolveSelector(federation, { types: ['IfcDoor'] });
    assert.deepEqual(doors, [{ modelId: 'm-asr', expressId: 2 }]);
  });

  it('returns [] for an empty selector, unknown model, or unknown type', () => {
    assert.deepEqual(resolveSelector(federation, {}), []);
    assert.deepEqual(resolveSelector(federation, { model: 'ELEKTRO' }), []);
    assert.deepEqual(resolveSelector(federation, { types: ['IfcSpaceship'] }), []);
  });

  it('skips models whose data store has not loaded yet', () => {
    const loading = new Map<string, SelectorResolvableModel>([
      ['x', { name: 'VZT.ifc', ifcDataStore: null }],
    ]);
    assert.deepEqual(resolveSelector(loading, { model: 'VZT' }), []);
  });
});
